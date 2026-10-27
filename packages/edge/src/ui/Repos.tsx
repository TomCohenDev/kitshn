import { useState } from "preact/hooks";
import type { RepoView } from "../core/protocol.ts";
import type { RepoState } from "../core/repos.ts";
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

const STICKERS: Record<RepoState, string> = { waiting: "wait", allowed: "ok", blocked: "" };

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
      <div class="label">Repos that deploy (K-819)</div>
      <ul class="repo-list">
        {[...props.repos]
          .sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting"))
          .map((repo) => (
            <li key={repo.repoId}>
              <code>{repo.name}</code>
              <span class={`sticker ${STICKERS[repo.state]}`}>{repo.state}</span>
              {repo.allowedBy ? (
                <span class="muted" title="An agent key allowed this repo; its apps stay in its circles (K-819)">
                  by {repo.allowedBy.name}
                </span>
              ) : null}
              {repo.state !== "allowed" ? (
                <button type="button" class="btn" disabled={busy.has(repo.repoId)} onClick={() => void decide(repo, "allowed")}>
                  Allow
                </button>
              ) : null}
              {repo.state === "waiting" && repo.branch !== null ? (
                <span class="muted">Allow starts {repo.branch}</span>
              ) : null}
              {/* An Allow whose start failed or met the pause keeps the branch to start again. */}
              {repo.state === "allowed" && repo.branch !== null ? (
                <button type="button" class="btn" disabled={busy.has(repo.repoId)} onClick={() => void decide(repo, "allowed")}>
                  Start {repo.branch}
                </button>
              ) : null}
              {repo.state !== "blocked" ? (
                <button type="button" class="btn danger" disabled={busy.has(repo.repoId)} onClick={() => void decide(repo, "blocked")}>
                  Block
                </button>
              ) : null}
              {repo.state === "waiting" ? (
                <button type="button" class="btn" disabled={busy.has(repo.repoId)} onClick={() => void decide(repo, "forget")}>
                  Forget
                </button>
              ) : null}
            </li>
          ))}
      </ul>
    </>
  );
}
