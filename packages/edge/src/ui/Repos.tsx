import { useState } from "preact/hooks";
import type { RepoView } from "../core/protocol.ts";
import type { RepoState } from "../core/repos.ts";
import { RepoIcon } from "./ItemIcon.tsx";
import { callApi } from "./store.ts";

type RepoAction = Exclude<RepoState, "waiting"> | "forget";

/** K-819: allows, blocks or forgets one repo by its GitHub repository id; returns the toast text. */
export async function setRepoState(
  repo: RepoView,
  state: RepoAction,
): Promise<{ text: string; error: boolean }> {
  const result = await callApi<{ dispatched?: string; dispatchError?: string; paused?: string }>(
    "POST",
    `/api/repos/${encodeURIComponent(repo.repoId)}`,
    { state },
  );
  if ("error" in result) return { text: result.error, error: true };
  if (state === "forget") return { text: `Forgot ${repo.name}.`, error: false };
  if (state === "blocked") return { text: `Blocked deploys of ${repo.name}.`, error: false };
  if (state === "allowed" && repo.allowedBy)
    return { text: `Took over ${repo.name} from ${repo.allowedBy.name}.`, error: false };
  if (result.dispatched)
    return { text: `Allowed ${repo.name} and started its deploy from ${result.dispatched}.`, error: false };
  if (result.paused)
    return {
      text: `Allowed ${repo.name}. kitshn is paused, so its deploy from ${result.paused} did not start; start it after Resume.`,
      error: false,
    };
  if (result.dispatchError)
    return {
      text: `Allowed ${repo.name}, but could not start its deploy: ${result.dispatchError}`,
      error: true,
    };
  return { text: `Allowed deploys of ${repo.name}. Run its workflow again to deploy.`, error: false };
}

export const REPO_STICKERS: Record<RepoState, { readonly style: string; readonly tip: string }> = {
  waiting: { style: "wait", tip: "Waiting: the first deploy of this repo waits for one click." },
  allowed: { style: "ok", tip: "Allowed: pushes of this repo deploy." },
  blocked: { style: "", tip: "Blocked: kitshn refuses deploys of this repo." },
};

/** K-819: the repos that deployed or wait to deploy; a waiting repo needs one click. */
export function RepoList(props: {
  repos: ReadonlyArray<RepoView>;
  onToast: (text: string, error: boolean) => void;
}) {
  // The buttons of a repo wait for its request, so a double click never starts a workflow twice.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  if (props.repos.length === 0) return null;
  const decide = async (repo: RepoView, state: RepoAction) => {
    setBusy((ids) => new Set(ids).add(repo.repoId));
    try {
      const { text, error } = await setRepoState(repo, state);
      props.onToast(text, error);
    } finally {
      setBusy((ids) => {
        const next = new Set(ids);
        next.delete(repo.repoId);
        return next;
      });
    }
  };
  return (
    <>
      <div class="label" data-tip="Repos that deploy: repos with a recipe. The first deploy of each waits for one click.">
        Repos that deploy
      </div>
      <ul class="repo-list">
        {[...props.repos]
          .sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting"))
          .map((repo) => (
            <li key={repo.repoId}>
              <RepoIcon name={repo.name} />
              <code>{repo.name}</code>
              <span class={`sticker ${REPO_STICKERS[repo.state].style}`} data-tip={REPO_STICKERS[repo.state].tip}>
                {repo.state}
              </span>
              {repo.allowedBy ? (
                <span class="muted" data-tip="An agent key allowed this repo; its apps stay in its circles.">
                  allowed by {repo.allowedBy.name}
                  {repo.keyRemoved ? ", key removed" : ""}
                </span>
              ) : null}
              {repo.state !== "allowed" && !repo.keyRemoved ? (
                <button
                  type="button"
                  class="btn"
                  disabled={busy.has(repo.repoId)}
                  data-tip={`Allow deploys of ${repo.name}${repo.branch ? ` and start ${repo.branch}` : ""}.`}
                  onClick={() => void decide(repo, "allowed")}
                >
                  Allow
                </button>
              ) : null}
              {/* K-819: the owner takes over a repo that an agent key allowed; its apps then follow the owner's rules. */}
              {repo.allowedBy ? (
                <button
                  type="button"
                  class="btn"
                  disabled={busy.has(repo.repoId)}
                  data-tip="Take over: the repo's apps then follow your rules, not the agent key's."
                  onClick={() => void decide(repo, "allowed")}
                >
                  Take over
                </button>
              ) : null}
              {repo.state === "waiting" && repo.branch !== null ? (
                <span class="muted">Allow starts {repo.branch}</span>
              ) : null}
              {/* An Allow whose start failed or met the pause keeps the branch to start again. */}
              {/* Take over already starts the branch of a repo that a key allowed. */}
              {repo.state === "allowed" && repo.branch !== null && !repo.allowedBy ? (
                <button
                  type="button"
                  class="btn"
                  disabled={busy.has(repo.repoId)}
                  data-tip={`Start the deploy of ${repo.branch} again.`}
                  onClick={() => void decide(repo, "allowed")}
                >
                  Start {repo.branch}
                </button>
              ) : null}
              {repo.state !== "blocked" ? (
                <button
                  type="button"
                  class="btn danger"
                  disabled={busy.has(repo.repoId)}
                  data-tip={`Block deploys of ${repo.name}: kitshn refuses them until you allow it again.`}
                  onClick={() => void decide(repo, "blocked")}
                >
                  Block
                </button>
              ) : null}
              {repo.state === "waiting" && !repo.keyRemoved ? (
                <button
                  type="button"
                  class="btn"
                  disabled={busy.has(repo.repoId)}
                  data-tip={`Forget ${repo.name}: it leaves this list until it asks to deploy again.`}
                  onClick={() => void decide(repo, "forget")}
                >
                  Forget
                </button>
              ) : null}
            </li>
          ))}
      </ul>
    </>
  );
}
