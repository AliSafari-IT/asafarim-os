/**
 * Share links for an article: plain links to each network's own share page, opened by the reader. Nothing is loaded
 * from those networks into ours (no widgets, scripts or trackers), and nothing is sent anywhere until the reader
 * clicks. "Copy link" is the one that needs a little script; it lives in components/CopyLinkButton.tsx.
 */

export type ShareId = "linkedin" | "x" | "email";

export interface ShareLink {
  id: ShareId;
  label: string;
  href: string;
}

/** X counts a link as 23 characters, so the text has room for about this much of a title. */
const MAX_TITLE = 200;

const enc = encodeURIComponent;

export function shareLinks(input: { url: string; title: string }): ShareLink[] {
  // Only ever share a web address.
  if (!/^https?:\/\//i.test(input.url)) return [];
  const title = input.title.trim();
  const short = title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title;
  return [
    {
      id: "linkedin",
      label: "LinkedIn",
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(input.url)}`,
    },
    {
      id: "x",
      label: "X",
      href: `https://x.com/intent/post?text=${enc(short)}&url=${enc(input.url)}`,
    },
    {
      id: "email",
      label: "Email",
      href: `mailto:?subject=${enc(title)}&body=${enc(`${title}\n\n${input.url}`)}`,
    },
  ];
}
