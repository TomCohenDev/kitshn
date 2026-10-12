from collections.abc import Mapping, Sequence
import json
from pathlib import Path
import subprocess

import pytest
import yaml

from kitshn.ci import deploy_over_ssh
from kitshn.cli import app
from kitshn.deploy import deploy_recipe
from kitshn.errors import KitshnError
from kitshn.models import Deployment, Recipe, Roots
from kitshn.preview_limits import PreviewLimits, parse_limits, preview_builder, preview_slice
from kitshn.resolve import ResolveInput, resolve_deployment
from kitshn.runner import CommandResult, CommandRunner

LIMITED_ENTRY = """
deploy:
  - on: push
    branch: main
    name: prod
  - on: pull_request
    name: pr-{pr}
    limits: {cpus: 1.5, memory: 3G}
"""


class Recorder(CommandRunner):
    """Records each command with its environment; answers config with two services."""

    def __init__(self, *, builder_exists: bool = False) -> None:
        super().__init__()
        self.builder_exists = builder_exists
        self.calls: list[tuple[tuple[str, ...], dict[str, str]]] = []

    def exists(self, executable: str) -> bool:
        return False

    def run(
        self,
        args: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
        capture: bool = False,
        input_text: str | None = None,
    ) -> CommandResult:
        command = tuple(args)
        self.calls.append((command, dict(env or {})))
        if command[:2] == ("git", "rev-parse"):
            return CommandResult(args=args, returncode=0, stdout="abc123\n", stderr="")
        if command[-3:] == ("config", "--format", "json"):
            config = {"services": {"site": {"build": {"context": "."}}, "api": {"build": {"context": "."}}}}
            return CommandResult(args=args, returncode=0, stdout=json.dumps(config), stderr="")
        if command[:3] == ("docker", "buildx", "inspect") and not self.builder_exists:
            return CommandResult(args=args, returncode=1, stdout="", stderr="no builder")
        return CommandResult(args=args, returncode=0, stdout="", stderr="")

    def env_of(self, subcommand: str) -> dict[str, str]:
        return next(env for command, env in self.calls if command[:2] == ("docker", "compose") and subcommand in command)

    def host_commands(self) -> list[tuple[str, ...]]:
        """Commands that change the host outside the deployment: systemd and the builder."""

        return [command for command, _ in self.calls if command[0] == "systemctl" or command[:2] in {("docker", "buildx"), ("docker", "update")}]


def _deployment(tmp_path: Path, environment: str) -> tuple[Deployment, Path]:
    roots = Roots(deployments=tmp_path / "d", params=tmp_path / "p", persistent=tmp_path / "s", logs=tmp_path / "l")
    deployment = Deployment.create(Recipe.parse("Yarden-zamir/tick3d"), environment, roots)
    (deployment.deployment_root / ".git").mkdir(parents=True)
    (deployment.deployment_root / "compose.yml").write_text("services: {}\n", encoding="utf-8")
    params = tmp_path / "params.env"
    params.write_text("", encoding="utf-8")
    return deployment, params


def _deploy(deployment: Deployment, params: Path, runner: Recorder, limits: PreviewLimits | None) -> None:
    deploy_recipe(
        deployment.recipe.full_name,
        params_file=params,
        ref="main",
        environment=deployment.environment,
        limits=limits,
        roots=deployment.roots,
        runner=runner,
    )


def test_limits_are_off_by_default_and_production_is_never_limited(tmp_path: Path) -> None:
    config = tmp_path / ".kitshn.yaml"
    config.write_text(LIMITED_ENTRY, encoding="utf-8")

    production = resolve_deployment(config, ResolveInput(event="push", branch="main"))
    preview = resolve_deployment(config, ResolveInput(event="pull_request", pr=7, branch="feature"))

    assert production.limits is None
    assert "limits=" in production.github_output_lines()
    assert preview.limits == PreviewLimits(cpu_percent=150, memory="3g")
    assert 'limits={"cpus": 1.5, "memory": "3g"}' in preview.github_output_lines()


@pytest.mark.parametrize("entry", ["on: push\n    branch: main", "on: push\n    branch: 'dev*'"])
def test_limits_on_a_push_entry_fail_the_resolve(tmp_path: Path, entry: str) -> None:
    config = tmp_path / ".kitshn.yaml"
    config.write_text(
        f"deploy:\n  - on: pull_request\n    name: pr-{{pr}}\n  - {entry}\n    name: x\n    limits: {{cpus: 1, memory: 1g}}\n",
        encoding="utf-8",
    )

    with pytest.raises(KitshnError, match="only to on: pull_request"):
        resolve_deployment(config, ResolveInput(event="pull_request", pr=7, branch="feature"))


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ({"cpus": 0, "memory": "1g"}, "at least 0.01"),
        ({"cpus": -1, "memory": "1g"}, "at least 0.01"),
        ({"cpus": True, "memory": "1g"}, "number of CPUs"),
        ({"cpus": "2", "memory": "1g"}, "number of CPUs"),
        ({"cpus": float("inf"), "memory": "1g"}, "number of CPUs"),
        ({"cpus": 2, "memory": 3072}, "512m or 3g"),
        ({"cpus": 2, "memory": "3"}, "512m or 3g"),
        ({"cpus": 2, "memory": "3gb"}, "512m or 3g"),
        ({"cpus": 2, "memory": "1.5g"}, "512m or 3g"),
        ({"cpus": 2, "memory": "0g"}, "512m or 3g"),
        ({"cpus": 2, "memory": "-1g"}, "512m or 3g"),
        ({"cpus": 2}, "cpus and memory"),
        ({"cpus": 2, "memory": "1g", "swap": "1g"}, "cpus and memory"),
        ([2, "1g"], "cpus and memory"),
    ],
)
def test_bad_limits_fail_with_the_expected_format(value: object, message: str) -> None:
    with pytest.raises(KitshnError, match=message):
        parse_limits(value)


def test_slice_and_builder_names_are_unique_per_recipe() -> None:
    recipe = Recipe.parse("Yarden-zamir/tick3d")

    # A dash in a slice name starts a child slice, so the owner's dash is escaped.
    assert preview_slice(recipe) == "kitshn-previews-yarden\\x2dzamir-tick3d.slice"
    assert preview_slice(Recipe.parse("yarden/zamir-tick3d")) != preview_slice(recipe)
    assert preview_builder(Recipe.parse("yarden/zamir-tick3d")) != preview_builder(recipe)
    with pytest.raises(KitshnError, match="systemd slice"):
        preview_slice(Recipe.parse("owner/re po"))


def test_a_limited_deploy_runs_in_the_slice_and_builds_in_the_limited_builder(
    tmp_path: Path, isolated_systemd_dir: Path
) -> None:
    deployment, params = _deployment(tmp_path, "pr-7")
    runner = Recorder()

    _deploy(deployment, params, runner, PreviewLimits.parse(1.5, "3g"))

    slice_name = preview_slice(deployment.recipe)
    unit = (isolated_systemd_dir / slice_name).read_text(encoding="utf-8")
    assert "CPUQuota=150%" in unit.splitlines()
    assert f"MemoryMax={3 * 1024**3}" in unit.splitlines()
    assert "MemorySwapMax=0" in unit.splitlines()
    override = yaml.safe_load(deployment.preview_limits_file.read_text(encoding="utf-8"))
    assert override == {"services": {name: {"cgroup_parent": slice_name} for name in ("api", "site")}}

    builder = preview_builder(deployment.recipe)
    assert runner.host_commands() == [
        ("systemctl", "daemon-reload"),
        ("docker", "buildx", "inspect", builder),
        ("docker", "buildx", "create", "--name", builder, "--driver", "docker-container"),
        ("docker", "buildx", "inspect", "--bootstrap", builder),
        ("docker", "update", "--memory", str(3 * 1024**3), "--memory-swap", str(3 * 1024**3), "--cpus", "1.5", f"buildx_buildkit_{builder}0"),
    ]
    for step in ("build", "up"):
        env = runner.env_of(step)
        assert env["BUILDX_BUILDER"] == builder
        assert env["COMPOSE_FILE"].split(":") == [
            str(deployment.deployment_root / "compose.yml"),
            str(deployment.preview_limits_file),
        ]


def test_the_limits_override_keeps_the_recipe_override_file(tmp_path: Path) -> None:
    deployment, params = _deployment(tmp_path, "pr-7")
    (deployment.deployment_root / "compose.override.yml").write_text("services: {}\n", encoding="utf-8")
    runner = Recorder(builder_exists=True)

    _deploy(deployment, params, runner, PreviewLimits.parse(2, "3g"))

    assert runner.env_of("up")["COMPOSE_FILE"].split(":")[1] == str(deployment.deployment_root / "compose.override.yml")
    # The builder exists, and the slice unit is new: no create, one reload.
    assert ("systemctl", "daemon-reload") in runner.host_commands()
    assert not any("create" in command for command in runner.host_commands())


def test_a_deploy_without_limits_drops_them_and_touches_no_host_settings(tmp_path: Path) -> None:
    deployment, params = _deployment(tmp_path, "pr-7")
    _deploy(deployment, params, Recorder(), PreviewLimits.parse(2, "3g"))
    runner = Recorder()

    _deploy(deployment, params, runner, None)

    assert not deployment.preview_limits_file.exists()
    assert runner.host_commands() == []
    for step in ("config", "build", "up"):
        assert "COMPOSE_FILE" not in runner.env_of(step)
        assert "BUILDX_BUILDER" not in runner.env_of(step)


def test_production_deploy_commands_do_not_change(tmp_path: Path, isolated_systemd_dir: Path) -> None:
    deployment, params = _deployment(tmp_path, "prod")
    runner = Recorder()

    _deploy(deployment, params, runner, None)

    assert runner.host_commands() == []
    assert list(isolated_systemd_dir.iterdir()) == []
    compose_envs = [env for command, env in runner.calls if command[:2] == ("docker", "compose")]
    assert compose_envs and all(env == deployment.runtime_env for env in compose_envs)


def test_limits_for_prod_fail_before_any_command(tmp_path: Path) -> None:
    deployment, params = _deployment(tmp_path, "prod")
    runner = Recorder()

    with pytest.raises(KitshnError, match="never apply to prod"):
        _deploy(deployment, params, runner, PreviewLimits.parse(2, "3g"))

    assert runner.calls == []


def test_deploy_cli_needs_both_limit_flags(tmp_path: Path) -> None:
    with pytest.raises(KitshnError, match="together"):
        app(["deploy", "owner/site", "--params-file", str(tmp_path / "p.env"), "--environment", "pr-1", "--limit-cpus", "2"])


def _remote_deploy_command(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> str:
    params_file = tmp_path / "params.env"
    params_file.write_text("", encoding="utf-8")
    commands: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", lambda args, check: commands.append(args))
    for name, value in {
        "GITHUB_REPOSITORY": "Owner/my-app",
        "KITSHN_VPS_HOST": "deploy@example.com",
        "KITSHN_SSH_KEY": "key",
        "KITSHN_ENVIRONMENT": "pr-7",
        "KITSHN_REF": "abc",
        "GITHUB_RUN_ID": "1",
    }.items():
        monkeypatch.setenv(name, value)
    deploy_over_ssh(params_file)
    return commands[-1][-1]


def test_ci_deploy_passes_limits_only_when_the_entry_sets_them(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KITSHN_LIMITS", raising=False)
    unset = _remote_deploy_command(monkeypatch, tmp_path)
    monkeypatch.setenv("KITSHN_LIMITS", "")
    empty = _remote_deploy_command(monkeypatch, tmp_path)
    monkeypatch.setenv("KITSHN_LIMITS", '{"cpus": 2.0, "memory": "3g"}')
    limited = _remote_deploy_command(monkeypatch, tmp_path)

    assert unset == empty
    assert "--limit" not in unset
    assert "--environment pr-7 --limit-cpus 2 --limit-memory 3g;" in limited
    monkeypatch.setenv("KITSHN_LIMITS", "2 cpus")
    with pytest.raises(KitshnError, match="JSON mapping"):
        _remote_deploy_command(monkeypatch, tmp_path)
