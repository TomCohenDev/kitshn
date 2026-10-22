"""The buildx builders that deployments build their images in.

Every builder runs at the lowest CPU weight. A build then uses the CPU that running services
leave idle, and running services always win the CPU. The weight is not a cap.
"""

from __future__ import annotations

from .runner import CommandRunner

# The builder of every deploy without preview limits, such as every production deploy.
HOST_BUILDER = "kitshn-builds"
# Docker maps 2 CPU shares to the cgroup v2 cpu.weight 1, the lowest weight. Other cgroups have
# weight 100. A deploy holds the host deploy lock during its build. If a busy host makes builds
# so slow that deploys queue on the lock, raise this value.
BUILD_CPU_SHARES = "2"


def ensure_builder(name: str, runner: CommandRunner, *limits: str) -> None:
    """Create the `docker-container` builder when it is missing, start it, and set its container's CPU weight.

    `limits` are more `docker update` flags for the builder container, such as `--cpus 2`.
    """

    if runner.run(["docker", "buildx", "inspect", name], capture=True, check=False).returncode != 0:
        runner.run(["docker", "buildx", "create", "--name", name, "--driver", "docker-container"])
    runner.run(["docker", "buildx", "inspect", "--bootstrap", name], capture=True)
    # buildx ignores its cgroup-parent option when Docker uses the systemd cgroup driver, so a
    # builder cannot join a slice. Set the weight and limits on its container instead; build
    # steps run inside it. buildx names that container buildx_buildkit_<builder>0. If buildx
    # renames it, this command fails the deploy, and the name needs an update here.
    container = f"buildx_buildkit_{name}0"
    runner.run(["docker", "update", "--cpu-shares", BUILD_CPU_SHARES, *limits, container])
