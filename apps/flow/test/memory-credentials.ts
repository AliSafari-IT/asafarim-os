/**
 * An in-memory `credentials` and `settings` table for the store's unit tests: it answers the
 * statements lib/credentials/store.ts, lib/credentials/cipher.ts and lib/settings.ts send, and
 * nothing else. The Postgres side is covered by test/egress.integration.test.ts.
 */
interface Row {
  id: string;
  name: string;
  kind: string;
  ciphertext: Buffer;
  iv: Buffer;
  key_version: number;
  meta: Record<string, unknown>;
  created_at: Date;
  created_by: string;
  rotated_at: Date | null;
  last_used_at: Date | null;
}

export function memoryCredentials() {
  const rows = new Map<string, Row>();
  const settings = new Map<string, unknown>();
  const statements: string[] = [];
  const db = {
    async query(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      const sql = text.replace(/\s+/g, " ").trim();
      statements.push(sql);
      const v = values;
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.startsWith("INSERT INTO credentials")) {
        if ([...rows.values()].some((r) => r.name === v[1])) return { rows: [] };
        rows.set(v[0] as string, {
          id: v[0] as string,
          name: v[1] as string,
          kind: v[2] as string,
          ciphertext: v[3] as Buffer,
          iv: v[4] as Buffer,
          key_version: v[5] as number,
          meta: JSON.parse(v[6] as string) as Record<string, unknown>,
          created_at: new Date(),
          created_by: v[7] as string,
          rotated_at: null,
          last_used_at: null,
        });
        return { rows: [{ id: v[0] }] };
      }
      if (sql.startsWith("SELECT id, name, kind, meta, created_at"))
        return {
          rows: [...rows.values()]
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
            .map(({ ciphertext: _c, iv: _i, key_version: _k, ...r }) => ({ ...r })),
        };
      if (sql.startsWith("SELECT kind FROM credentials WHERE id = $1")) {
        const r = rows.get(v[0] as string);
        return { rows: r ? [{ kind: r.kind }] : [] };
      }
      if (sql.startsWith("SELECT kind, ciphertext, iv, key_version, meta FROM credentials WHERE id = $1")) {
        const r = rows.get(v[0] as string);
        return { rows: r ? [{ ...r }] : [] };
      }
      if (sql.startsWith("SELECT id, ciphertext, iv, key_version FROM credentials WHERE key_version <> $1"))
        return { rows: [...rows.values()].filter((r) => r.key_version !== v[0]).map((r) => ({ ...r })) };
      if (sql.startsWith("UPDATE credentials SET ciphertext = $2, iv = $3, key_version = $4")) {
        const r = rows.get(v[0] as string)!;
        Object.assign(r, { ciphertext: v[1], iv: v[2], key_version: v[3] });
        if (sql.includes("rotated_at = now()")) r.rotated_at = new Date();
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE credentials SET last_used_at = now() WHERE id = $1")) {
        rows.get(v[0] as string)!.last_used_at = new Date();
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM credentials WHERE id = $1")) {
        const r = rows.get(v[0] as string);
        rows.delete(v[0] as string);
        return { rows: r ? [{ kind: r.kind }] : [] };
      }
      if (sql.startsWith("SELECT key, value FROM settings"))
        return { rows: [...settings].map(([key, value]) => ({ key, value })) };
      if (sql.startsWith("SELECT value FROM settings WHERE key = 'paused_all'"))
        return { rows: settings.has("paused_all") ? [{ value: settings.get("paused_all") }] : [] };
      if (sql.startsWith("INSERT INTO settings")) {
        settings.set(v[0] as string, JSON.parse(v[1] as string));
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { db, rows, settings, statements };
}
