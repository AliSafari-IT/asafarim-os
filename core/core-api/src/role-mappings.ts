/**
 * Administrator-configured role mappings (#355, ADR 0004): `source_role → target_role`. Whoever holds the
 * source DIRECTLY (a deliberate grant) also holds the target, as a derived row in role_grants with
 * `granted_by = mapping:<id>`. Core names no app here: a mapping is data only an admin writes.
 *
 * Every change that can move a derived grant (a grant or revoke, a mapping created or deleted) calls
 * `reconcile` in its own transaction, under one advisory lock, so two changes can't interleave. Reconciling
 * never removes a deliberate grant: it only adds, re-attributes or deletes rows whose granted_by is a mapping.
 */
import type pg from "pg";

type Db = Pick<pg.PoolClient, "query">;

export const MAPPING_PREFIX = "mapping:";
export const isDerived = (grantedBy: string) => grantedBy.startsWith(MAPPING_PREFIX);
export const mappingActor = (id: string | number) => `${MAPPING_PREFIX}${id}`;

/** Serializes every grant, revoke and mapping change for the rest of the transaction. */
export async function lockMappings(c: Db): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('core.role_mappings'))");
}

export interface DerivedChange {
  action: "role.granted" | "role.revoked";
  role: string;
  appId: string;
  subject: string;
  via: string;
}

/**
 * Bring `subject`'s derived grants in line with the mappings and their deliberate grants. Returns what
 * was added or removed (the caller audits it). Mappings whose roles are deprecated derive nothing.
 */
export async function reconcile(c: Db, subject: string): Promise<DerivedChange[]> {
  // What the mappings entitle this subject to: per target role, the lowest mapping id that does.
  const wanted = new Map(
    (
      await c.query<{ target_role: string; id: string; app_id: string }>(
        `SELECT DISTINCT ON (m.target_role) m.target_role, m.id::text AS id, t.app_id
           FROM role_mappings m
           JOIN role_grants g ON g.role_key = m.source_role AND g.subject = $1 AND g.granted_by NOT LIKE 'mapping:%'
           JOIN roles s ON s.key = m.source_role AND s.deprecated_at IS NULL
           JOIN roles t ON t.key = m.target_role AND t.deprecated_at IS NULL
          ORDER BY m.target_role, m.id`,
        [subject],
      )
    ).rows.map((r) => [r.target_role, { via: mappingActor(r.id), appId: r.app_id }]),
  );
  const held = (
    await c.query<{ role_key: string; granted_by: string; app_id: string }>(
      `SELECT g.role_key, g.granted_by, r.app_id FROM role_grants g JOIN roles r ON r.key = g.role_key
        WHERE g.subject = $1`,
      [subject],
    )
  ).rows;
  const changes: DerivedChange[] = [];
  const has = new Set(held.map((h) => h.role_key));
  for (const h of held) {
    if (!isDerived(h.granted_by)) continue;
    const want = wanted.get(h.role_key);
    if (!want) {
      await c.query("DELETE FROM role_grants WHERE role_key = $1 AND subject = $2 AND granted_by = $3", [
        h.role_key,
        subject,
        h.granted_by,
      ]);
      changes.push({ action: "role.revoked", role: h.role_key, appId: h.app_id, subject, via: h.granted_by });
    } else if (want.via !== h.granted_by) {
      // Still entitled, through another mapping now: keep the grant, move its provenance.
      await c.query("UPDATE role_grants SET granted_by = $3 WHERE role_key = $1 AND subject = $2", [
        h.role_key,
        subject,
        want.via,
      ]);
    }
  }
  for (const [role, want] of wanted) {
    if (has.has(role)) continue; // held already: deliberately (which wins) or derived (handled above)
    await c.query("INSERT INTO role_grants (role_key, subject, granted_by) VALUES ($1, $2, $3)", [
      role,
      subject,
      want.via,
    ]);
    changes.push({ action: "role.granted", role, appId: want.appId, subject, via: want.via });
  }
  return changes;
}

export interface RoleMapping {
  id: number;
  source: string;
  target: string;
  createdBy: string;
  createdAt: string;
  /** People who hold the target through this mapping now. */
  derivedGrants: number;
}

export async function listMappings(db: Pick<pg.Pool, "query">): Promise<RoleMapping[]> {
  const { rows } = await db.query<{
    id: string;
    source_role: string;
    target_role: string;
    created_by: string;
    created_at: Date;
    derived: number;
  }>(
    `SELECT m.*, (SELECT count(*)::int FROM role_grants g WHERE g.granted_by = 'mapping:' || m.id) AS derived
       FROM role_mappings m ORDER BY m.source_role, m.target_role`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    source: r.source_role,
    target: r.target_role,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    derivedGrants: r.derived,
  }));
}
