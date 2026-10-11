/** The file tree as the browser gets it (#80): readable labels, worked out on the server. */
export interface NavNode {
  /** What the reader sees: `example-app` → "Example App", `roadmap.md` → "Roadmap". */
  label: string;
  /** The file's path; unset for a folder. */
  path?: string;
  kind?: "doc" | "image";
  children: NavNode[];
}
