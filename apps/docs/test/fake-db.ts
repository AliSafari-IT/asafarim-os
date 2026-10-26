/**
 * Postgres, as far as the notes store uses it: the `notes` table and the event outbox, every
 * statement recorded. A client from `connect()` works on its own copy between BEGIN and COMMIT, and
 * ROLLBACK drops it, so a test sees what a failed transaction leaves behind. `failOn` makes the
 * first matching statement throw (a lost connection, a constraint).
 */
export interface FakeDb {
  pool: never;
  statements: { sql: string; params: unknown[] }[];
  notes: Record<string, unknown>[];
  outbox: { id: string; type: string; envelope: { subject?: string; data: Record<string, unknown> } }[];
  failOn?: (sql: string) => boolean;
}

interface Tables {
  notes: Record<string, unknown>[];
  outbox: FakeDb["outbox"];
}

const copy = (t: Tables): Tables => ({ notes: t.notes.map((r) => ({ ...r })), outbox: [...t.outbox] });

export function fakeDb(): FakeDb {
  let committed: Tables = { notes: [], outbox: [] };
  let next = 1;
  const db: FakeDb = {
    pool: undefined as never,
    statements: [],
    get notes() {
      return committed.notes;
    },
    get outbox() {
      return committed.outbox;
    },
  };

  /** Record the statement, and throw if it is the one `failOn` picks. */
  const record = (sql: string, params: unknown[]) => {
    db.statements.push({ sql, params });
    if (db.failOn?.(sql)) {
      db.failOn = undefined;
      throw new Error("connection lost");
    }
  };

  const run = async (t: Tables, sql: string, params: unknown[]) => {
    if (sql.includes("CREATE TABLE")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO asafarim_outbox")) {
      const [id, type, envelope] = params as [string, string, string];
      t.outbox.push({ id, type, envelope: JSON.parse(envelope) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT")) {
      if (sql.includes("FOR UPDATE")) {
        const [author, id] = params;
        return { rows: t.notes.filter((r) => r.author === author && r.id === id).map((r) => ({ ...r })) };
      }
      const [author, doc] = params;
      return {
        rows: t.notes.filter((r) => r.author === author && (doc === null || r.doc_path === doc)).map((r) => ({ ...r })),
      };
    }
    if (sql.startsWith("INSERT INTO notes")) {
      const [author, doc_path, heading_id, quote, body, doc_sha] = params;
      const now = new Date();
      const row = {
        id: String(next++),
        author,
        doc_path,
        heading_id,
        quote,
        body,
        doc_sha,
        issue_url: null,
        created_at: now,
        updated_at: now,
      };
      t.notes.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith("UPDATE")) {
      const [author, id, value] = params;
      const row = t.notes.find((r) => r.id === id && r.author === author);
      const column = sql.includes("issue_url =") ? "issue_url" : "body";
      if (row) Object.assign(row, { [column]: value, updated_at: new Date() });
      return { rows: row ? [{ ...row }] : [] };
    }
    if (sql.startsWith("DELETE")) {
      const [author, id] = params;
      const i = t.notes.findIndex((r) => r.id === id && r.author === author);
      if (i !== -1) t.notes.splice(i, 1);
      return { rows: [], rowCount: i === -1 ? 0 : 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };

  const query = async (sql: string, params: unknown[] = []) => {
    record(sql, params);
    return run(committed, sql, params);
  };

  const connect = async () => {
    let tx: Tables | undefined;
    return {
      async query(sql: string, params: unknown[] = []) {
        record(sql, params);
        if (sql === "BEGIN") {
          tx = copy(committed);
          return { rows: [] };
        }
        if (sql === "COMMIT") {
          if (tx) committed = tx;
          tx = undefined;
          return { rows: [] };
        }
        if (sql === "ROLLBACK") {
          tx = undefined;
          return { rows: [] };
        }
        return run(tx ?? committed, sql, params);
      },
      release() {},
    };
  };

  db.pool = { query, connect } as never;
  return db;
}
