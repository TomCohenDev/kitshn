import { useState } from "preact/hooks";
import { type GitHubWay, type Resource } from "../core/model.ts";
import type { RepoView } from "../core/protocol.ts";
import { matchProblem, repoGroupMatches } from "../core/repoGroups.ts";
import { Radio } from "./controls.tsx";
import { callApi } from "./store.ts";

const WAY_TEXT: Record<GitHubWay, { readonly label: string; readonly tip: string }> = {
  app: {
    label: "kitshn App token",
    tip: "kitshn App token: agents get a 1-hour token for one repo through kitshn, with their right and its mode.",
  },
  "not-kitshn": {
    label: "not kitshn",
    tip: "Not kitshn: the machine uses its own GitHub login; kitshn sees no repo name of this owner.",
  },
};

/** K-1733: the cards of the repos that a repo group matches, for the highlight of K-1734. */
export const matchedCards = (group: Resource, repos: ReadonlyArray<RepoView>): Array<string> =>
  group.match === undefined
    ? []
    : repos
        .filter((repo) => repoGroupMatches(group.match ?? "", repo.name))
        .flatMap((repo) => repo.resourceIds);

/** K-1733: a new repo group; its card waits in the tray, private. */
export function AddRepoGroup(props: {
  readonly onClose: () => void;
  readonly onDone: (text: string) => void;
}) {
  const [match, setMatch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const problem = matchProblem(match.trim());
    if (problem) return setError(problem);
    setBusy(true);
    const result = await callApi<{ id: string }>("POST", "/api/repo-groups", { match: match.trim() });
    setBusy(false);
    if ("error" in result) return setError(result.error);
    props.onDone(`Added the repo group ${match.trim()}. Its card waits in the tray.`);
    props.onClose();
  };
  return (
    <div class="scrim" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div class="dialog" role="dialog" aria-label="Add a repo group">
        <h2>Add a repo group</h2>
        <p class="help">
          An owner, such as <code>Yarden-zamir</code>, or a pattern with one *, such as{" "}
          <code>Yarden-zamir/trek-*</code>. Put the card in an agent circle with a machine, and its code
          rights cover every repo that it matches.
        </p>
        <input
          aria-label="Match"
          value={match}
          placeholder="owner or owner/pattern-*"
          onInput={(event) => setMatch(event.currentTarget.value)}
        />
        {error ? <p class="error">{error}</p> : null}
        <div class="row">
          <button type="button" class="btn" disabled={busy} onClick={() => void add()}>
            Add
          </button>
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * K-1733, K-1760: the panel part of a repo group: the repos that it matches, the GitHub way of an owner group, and
 * Delete. Name patterns match by name, so a renamed repo can fall in or out (K-1733).
 */
export function RepoGroupPanel(props: {
  readonly group: Resource;
  readonly repos: ReadonlyArray<RepoView>;
  readonly onToast: (text: string, error: boolean) => void;
}) {
  const { group } = props;
  const match = group.match ?? "";
  const matched = props.repos.filter((repo) => repoGroupMatches(match, repo.name));
  const owner = !match.includes("/");
  const way = group.githubWay ?? null;
  const setWay = async (next: GitHubWay) => {
    const result = await callApi<{ githubWay: string }>(
      "POST",
      `/api/repo-groups/${encodeURIComponent(group.id)}`,
      {
        githubWay: next,
      },
    );
    props.onToast("error" in result ? result.error : `${match}: ${WAY_TEXT[next].label}.`, "error" in result);
  };
  const remove = async () => {
    const result = await callApi<{ deleted: string }>(
      "DELETE",
      `/api/repo-groups/${encodeURIComponent(group.id)}`,
    );
    props.onToast("error" in result ? result.error : `Deleted the repo group ${match}.`, "error" in result);
  };
  return (
    <>
      <p class="help">
        Matches <code>{match}</code>:{" "}
        {matched.length === 0 ? "no repo that kitshn knows yet" : `${matched.length} repos`}.
      </p>
      <ul class="repo-list">
        {matched.map((repo) => (
          <li key={repo.repoId}>
            <code>{repo.name}</code>
          </li>
        ))}
      </ul>
      {owner ? (
        <fieldset class="right-mode">
          <legend data-tip="K-1760: how agents reach the repos of this owner.">GitHub way</legend>
          {(["app", "not-kitshn"] as const).map((each) => (
            <Radio
              key={each}
              name={`way-${group.id}`}
              checked={way === each}
              label={WAY_TEXT[each].label}
              tip={WAY_TEXT[each].tip}
              onSelect={() => void setWay(each)}
            />
          ))}
          {way === null ? <span class="help">No way set: the default of Settings counts.</span> : null}
        </fieldset>
      ) : null}
      <div class="row">
        <button
          type="button"
          class="btn"
          data-tip="Delete this repo group. Its rights stop covering these repos at once; add it again to bring them back."
          onClick={() => void remove()}
        >
          Delete
        </button>
      </div>
    </>
  );
}

/** K-1760: the GitHub way of an owner that has no owner group; "not kitshn" when kitshn starts. */
export function GitHubDefaultWay(props: {
  readonly way: GitHubWay;
  readonly onToast: (text: string, error: boolean) => void;
}) {
  const set = async (next: GitHubWay) => {
    const result = await callApi<{ githubWay: string }>("POST", "/api/settings/github-way", {
      githubWay: next,
    });
    props.onToast(
      "error" in result ? result.error : `Owners with no repo group: ${WAY_TEXT[next].label}.`,
      "error" in result,
    );
  };
  return (
    <fieldset class="right-mode">
      <legend data-tip="K-1760: the GitHub way of every owner that has no owner repo group.">
        GitHub way of other owners
      </legend>
      {(["not-kitshn", "app"] as const).map((each) => (
        <Radio
          key={each}
          name="github-default-way"
          checked={props.way === each}
          label={WAY_TEXT[each].label}
          tip={WAY_TEXT[each].tip}
          onSelect={() => void set(each)}
        />
      ))}
    </fieldset>
  );
}
