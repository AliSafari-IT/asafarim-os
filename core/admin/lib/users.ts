/**
 * Finding people to grant roles to. Locally that's the SEEDED synthetic users (tools/dev-hub/seed-users.json,
 * `ADMIN_USER_DIRECTORY_FILE`, set by `pnpm dev`); there's no production directory yet, so without the
 * file the console still works: type a subject id. The directory is read-only and never written.
 */
import { readFileSync } from "node:fs";

export interface DirectoryUser {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
}

export function parseDirectory(text: string): DirectoryUser[] {
  const doc = JSON.parse(text) as { users?: Record<string, unknown>[] };
  return (doc.users ?? []).flatMap((u) =>
    typeof u.id === "string"
      ? [
          {
            id: u.id,
            name: typeof u.name === "string" ? u.name : u.id,
            email: typeof u.email === "string" ? u.email : "",
            isActive: u.isActive !== false,
          },
        ]
      : [],
  );
}

/** Case-insensitive match on id, name or email; no query lists everyone. At most `limit`. */
export function searchUsers(users: readonly DirectoryUser[], query: string, limit = 20): DirectoryUser[] {
  const q = query.trim().toLowerCase();
  const hit = (u: DirectoryUser) =>
    q === "" || [u.id, u.name, u.email].some((field) => field.toLowerCase().includes(q));
  return users.filter(hit).slice(0, limit);
}

export function loadDirectory(file = process.env.ADMIN_USER_DIRECTORY_FILE): DirectoryUser[] {
  if (!file) return [];
  try {
    return parseDirectory(readFileSync(file, "utf8"));
  } catch {
    return []; // a missing or unreadable directory only means "type the subject id"
  }
}
