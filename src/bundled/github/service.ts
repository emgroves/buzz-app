// What the GitHub plugin offers other plugins: the pull request states the
// app already holds. It never reads GitHub, so a plugin can use what links,
// the panel and agents' watches have read without spending GitHub's limit.
import type { PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";

/** The pull request states the app holds, read-only. */
export type GitHubPulls = Readonly<{
  /** The state the app last read of the pull request `url` names; undefined
   * when it holds none (never read, could not be read, forgotten after
   * nobody showed it for a while) or `url` is not a pull request's (or one
   * of its pages, such as its files). A merged
   * pull request stays merged. */
  pullState(url: string): "open" | "draft" | "merged" | "closed" | undefined;
  /** Calls `listener` when a held state changes; read `pullState` again
   * then. It does not make the app read anything. */
  subscribe(listener: () => void): () => void;
}>;

export function gitHubPulls(states: PullStates): GitHubPulls {
  return Object.freeze({
    pullState(url: string) {
      // As a link names it: a pull request's files or commits page is the
      // pull request.
      const pull = parseGitHubReference(url, { pullSubtargets: true });
      if (pull?.kind !== "pull") return undefined;
      const state = states.get(pull.url);
      return typeof state === "object" ? state.state : undefined;
    },
    subscribe: (listener: () => void) => states.observe(listener),
  });
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    github: GitHubPulls;
  }
}
