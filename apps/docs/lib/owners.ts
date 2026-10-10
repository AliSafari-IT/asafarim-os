/**
 * Which repository owns a document (#78). The source repo has a `docs-app.json` at its root:
 *
 *   { "owners": [ { "path": "ventures/x/**", "repo": "owner/x" }, { "path": "**", "repo": "owner/docs" } ] }
 *
 * The first matching `path` wins; a document's front matter (`repo: owner/name`) overrides it; with
 * no match the source repo itself owns it. Pure: no I/O, so it runs in tests and on the server alike.
 */
import { z } from "zod";

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

const ownersSchema = z.strictObject({
  owners: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(300),
        repo: z.string().regex(REPO, "must be owner/name"),
      }),
    )
    .max(200),
});

export type OwnersConfig = z.infer<typeof ownersSchema>;

export type ParsedOwners = { ok: true; config: OwnersConfig } | { ok: false; error: string };

/** Parse `docs-app.json`. A broken file is an error to show, never an exception. */
export function parseOwnersConfig(text: string): ParsedOwners {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "docs-app.json isn't valid JSON" };
  }
  const r = ownersSchema.safeParse(json);
  if (r.success) return { ok: true, config: r.data };
  const first = r.error.issues[0]!;
  const where = first.path.length ? first.path.join(".") : "the file";
  return { ok: false, error: `docs-app.json: ${where} ${first.message}` };
}

/** `*` is one path segment, `**` any depth (a trailing `/**` also matches the folder itself). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** The `repo:` line of a document's front matter (a leading `---` block), if it names a valid repo. */
export function frontMatterRepo(markdown: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!m) return undefined;
  const line = /^repo:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(m[1]!);
  return line && REPO.test(line[1]!) ? line[1] : undefined;
}

export interface Owner {
  repo: string;
  /** Where the answer came from. */
  via: "front-matter" | "config" | "fallback";
}

/** The repository that owns `path`: front matter, else the first matching rule, else `fallbackRepo`. */
export function ownerOf(path: string, opts: { config?: OwnersConfig; markdown?: string; fallbackRepo: string }): Owner {
  const fromDoc = opts.markdown === undefined ? undefined : frontMatterRepo(opts.markdown);
  if (fromDoc) return { repo: fromDoc, via: "front-matter" };
  const rule = opts.config?.owners.find((o) => globToRegExp(o.path).test(path));
  if (rule) return { repo: rule.repo, via: "config" };
  return { repo: opts.fallbackRepo, via: "fallback" };
}
