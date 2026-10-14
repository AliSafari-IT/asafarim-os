/** Only a GitHub issue's own URL is ever shown as a note's issue link (#82). Shared by the server and the browser. */
export const issueHref = (url: string | null): string | undefined =>
  url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(url) ? url : undefined;
