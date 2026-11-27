/**
 * Finding people to grant roles to. In production that's identity's directory (`GET /admin/v1/users`, the same one
 * the Users page lists); where identity has none (Hub mode, the dev login stub), the SEEDED synthetic users
 * (tools/dev-hub/seed-users.json, `ADMIN_USER_DIRECTORY_FILE`, set by `pnpm dev`). With neither, the console still
 * works: type a subject id. Both are read-only and never written.
 */
import { readFileSync } from "node:fs";
import { identityApi, type DirectoryPerson } from "./identity-api";

/** Where the Roles page keeps its person search (an email address must not go into a URL). */
export const ROLES_QUERY_COOKIE = "admin-roles-q";

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

/** A person from identity's directory, in the shape the role picker shows. */
export function fromIdentity(p: DirectoryPerson): DirectoryUser {
  return {
    id: p.id,
    name: p.label ?? `Account ${p.id.slice(0, 8)}…`,
    email: p.email ?? "",
    isActive: p.state === "active",
  };
}

export type PeopleSource = "identity" | "seed" | "none";

/** People matching `query`: identity's directory when it answers, else the seeded users, else nobody. */
export async function findPeople(
  idToken: string,
  query: string,
  limit = 20,
  deps: { identity?: ReturnType<typeof identityApi>; seed?: () => DirectoryUser[] } = {},
): Promise<{ people: DirectoryUser[]; source: PeopleSource }> {
  const identity = deps.identity ?? identityApi(idToken);
  try {
    const q = query.trim();
    const page = await identity.users({ ...(q ? { q } : {}), limit });
    return { people: page.users.map(fromIdentity), source: "identity" };
  } catch {
    const seeded = (deps.seed ?? loadDirectory)();
    return seeded.length
      ? { people: searchUsers(seeded, query, limit), source: "seed" }
      : { people: [], source: "none" };
  }
}
