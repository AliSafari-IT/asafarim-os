/**
 * The issue a person pastes to generate a workflow draft from (#283): exactly
 *
 *   https://github.com/<owner>/<repo>/issues/<number>
 *   https://gitlab.com/<group>[/<subgroup>…]/<project>/-/issues/<number>
 *
 * and nothing else: no other host (look-alikes, subdomains, GitHub Enterprise, self-hosted GitLab), no
 * port, no userinfo, no query, no encoded or dot segments. The URL is compared with what the parser makes
 * of it, so a form that only normalises to an issue URL (`/a/../b`, a backslash, a tab) is refused too.
 * A trailing `#fragment` is allowed and ignored. Nothing here fetches: lib/generate/issue-source.ts does,
 * from the API host the reference names, never from the URL itself.
 */

export type IssueRef =
  { host: "github"; owner: string; repo: string; number: number } | { host: "gitlab"; project: string; number: number };

/** Longest URL accepted. */
export const MAX_ISSUE_URL_LENGTH = 2048;

/** GitHub's rules: an owner of letters, digits and inner hyphens (≤ 39); a repo of letters, digits, `.`, `_`, `-`. */
const GITHUB_PATH =
  /^\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})\/issues\/([1-9]\d{0,9})\/?$/;
/** GitLab: up to 20 namespace levels, each a path segment GitLab allows, then `/-/issues/<n>`. */
const GITLAB_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}";
const GITLAB_PATH = new RegExp(`^/((?:${GITLAB_SEGMENT}/){1,20}${GITLAB_SEGMENT})/-/issues/([1-9]\\d{0,9})/?$`);
const MAX_GITLAB_PROJECT_PATH = 255;

/** A segment that is only dots, or ends in `.git`/`.atom`, is never a project or repo name. */
const badSegment = (s: string) => /^\.+$/.test(s) || /\.(?:git|atom)$/i.test(s);

const hasControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** The issue the URL names, or undefined when it isn't one of the two exact forms. */
export function parseIssueUrl(raw: string): IssueRef | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  // Whitespace, control characters, backslashes and percent-encoding are never part of an issue URL.
  if (!text || text.length > MAX_ISSUE_URL_LENGTH || /[\s\\%]/.test(text) || hasControl(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search) return undefined;
  // What the parser made of it must be what was written (host case aside): no normalisation tricks.
  const hash = text.indexOf("#");
  const written = hash === -1 ? text : text.slice(0, hash);
  if (written.toLowerCase() !== `${url.origin}${url.pathname}`.toLowerCase()) return undefined;
  if (written.slice(url.origin.length) !== url.pathname) return undefined;

  if (url.hostname === "github.com") {
    const m = GITHUB_PATH.exec(url.pathname);
    if (!m || badSegment(m[2]!)) return undefined;
    return { host: "github", owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
  }
  if (url.hostname === "gitlab.com") {
    const m = GITLAB_PATH.exec(url.pathname);
    if (!m || m[1]!.length > MAX_GITLAB_PROJECT_PATH || m[1]!.split("/").some(badSegment)) return undefined;
    return { host: "gitlab", project: m[1]!, number: Number(m[2]) };
  }
  return undefined;
}

/** The issue as audit ids: host, repository path, number. Never the URL a person typed. */
export function sourceOf(ref: IssueRef): { host: "github" | "gitlab"; repo: string; number: number } {
  return ref.host === "github"
    ? { host: "github", repo: `${ref.owner}/${ref.repo}`, number: ref.number }
    : { host: "gitlab", repo: ref.project, number: ref.number };
}
