import type { RepoView } from "../core/protocol.ts";
import type { RepoState } from "../core/repos.ts";
import { callApi } from "./store.ts";

/** K-819: allows or blocks the deploys of one repo, by its GitHub repository id. */
export async function setRepoState(repo: RepoView, state: Exclude<RepoState, "waiting">) {
  const result = await callApi<{ state: RepoState }>("POST", `/api/repos/${encodeURIComponent(repo.repoId)}`, {
    state,
  });
  return "error" in result ? result.error : null;
}

const STICKERS: Record<RepoState, string> = { waiting: "wait", allowed: "ok", blocked: "" };

/** K-819: the repos that deployed or wait to deploy; a waiting repo needs one click. */
export function RepoList(props: {
  repos: ReadonlyArray<RepoView>;
  onToast: (text: string, error: boolean) => void;
}) {
  if (props.repos.length === 0) return null;
  const decide = async (repo: RepoView, state: Exclude<RepoState, "waiting">) => {
    const error = await setRepoState(repo, state);
    props.onToast(error ?? `${state === "allowed" ? "Allowed" : "Blocked"} deploys of ${repo.name}.`, error !== null);
  };
  return (
    <>
      <div class="label">Repos that deploy (K-819)</div>
      <ul class="repo-list">
        {[...props.repos]
          .sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting"))
          .map((repo) => (
            <li key={repo.repoId}>
              <code>{repo.name}</code>
              <span class={`sticker ${STICKERS[repo.state]}`}>{repo.state}</span>
              {repo.state !== "allowed" ? (
                <button type="button" class="btn" onClick={() => void decide(repo, "allowed")}>
                  Allow
                </button>
              ) : null}
              {repo.state !== "blocked" ? (
                <button type="button" class="btn danger" onClick={() => void decide(repo, "blocked")}>
                  Block
                </button>
              ) : null}
            </li>
          ))}
      </ul>
    </>
  );
}
