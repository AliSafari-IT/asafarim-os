/**
 * GitHub deliveries and the `github` trigger's filter. A delivery is named by its X-GitHub-Event and
 * the payload's `action`: `issues` with action `opened` is both `issues` and `issues.opened`; a
 * `pull_request` `closed` whose pull request was merged is also `pull_request.closed+merged`. The
 * trigger takes a delivery when one of its `events` is one of those names and the payload's
 * `repository.full_name` is one of its `repos` (GitHub compares names without case; so does this).
 */
import type { TriggerV2 } from "../workflow/definition-v2";

type GithubTrigger = Extract<TriggerV2, { type: "github" }>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The names a delivery of `event` with `payload` goes by. */
export function githubEventNames(event: string, payload: Record<string, unknown>): string[] {
  const names = [event];
  const action = typeof payload.action === "string" ? payload.action : undefined;
  if (action !== undefined) names.push(`${event}.${action}`);
  const pr = payload.pull_request;
  if (event === "pull_request" && action === "closed" && isRecord(pr) && pr.merged === true) {
    names.push("pull_request.closed+merged");
  }
  return names;
}

/** The repository a delivery is about, `owner/name`. */
export function githubRepository(payload: Record<string, unknown>): string | undefined {
  const repo = payload.repository;
  return isRecord(repo) && typeof repo.full_name === "string" ? repo.full_name : undefined;
}

/** Whether `trigger` takes a delivery of `event` with `payload`. */
export function githubAccepts(trigger: GithubTrigger, event: string, payload: Record<string, unknown>): boolean {
  const repo = githubRepository(payload)?.toLowerCase();
  if (repo === undefined || !trigger.repos.some((r) => r.toLowerCase() === repo)) return false;
  const names = githubEventNames(event, payload);
  return trigger.events.some((e) => names.includes(e));
}

/**
 * A delivery's payload as the run's trigger data, with `labels` added: the names of the issue's (or
 * the pull request's) labels, which GitHub sends as objects. So a condition can read
 * `trigger.labels contains "bug"`. A `labels` the payload has itself is replaced.
 */
export function githubTriggerData(payload: Record<string, unknown>): Record<string, unknown> {
  const item = isRecord(payload.issue) ? payload.issue : isRecord(payload.pull_request) ? payload.pull_request : {};
  const raw = Array.isArray(item.labels) ? item.labels : [];
  const labels = raw.flatMap((l) =>
    isRecord(l) && typeof l.name === "string" ? [l.name] : typeof l === "string" ? [l] : [],
  );
  return { ...payload, labels };
}
