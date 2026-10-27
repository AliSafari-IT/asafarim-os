/**
 * Postgres, as far as the notes store and the event handlers use it: the `notes` table, the event
 * outbox and the inbox, every statement recorded. A client from `connect()` works on its own copy between BEGIN and COMMIT;
 * COMMIT applies its writes to the committed rows (so a write committed on its own meanwhile stays, as
 * in Postgres), and ROLLBACK drops them, so a test sees what a failed transaction leaves behind. `failOn` makes the
 * first matching statement throw (a lost connection, a constraint).
 */
export interface FakeDb {
  pool: never;
  statements: { sql: string; params: unknown[] }[];
  notes: Record<string, unknown>[];
  outbox: { id: string; type: string; envelope: { subject?: string; data: Record<string, unknown> } }[];
  inbox: string[];
  failOn?: (sql: string) => boolean;
}

interface Tables {
  notes: Record<string, unknown>[];
  outbox: FakeDb["outbox"];
  inbox: string[];
}

const copy = (t: Tables): Tables => ({
  notes: t.notes.map((r) => ({ ...r })),
  outbox: [...t.outbox],
  inbox: [...t.inbox],
});

export function fakeDb(): FakeDb {
  const committed: Tables = { notes: [], outbox: [], inbox: [] };
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
    get inbox() {
      return committed.inbox;
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

  /** A write, as a change that can be applied to any copy of the tables (a transaction's, then the committed one). */
  type Change = (t: Tables) => { rows: unknown[]; rowCount?: number };

  const change = (sql: string, params: unknown[]): Change | undefined => {
    if (sql.startsWith("INSERT INTO asafarim_outbox")) {
      const [id, type, envelope] = params as [string, string, string];
      const entry = { id, type, envelope: JSON.parse(envelope) };
      return (t) => {
        t.outbox.push(entry);
        return { rows: [], rowCount: 1 };
      };
    }
    if (sql.startsWith("INSERT INTO asafarim_inbox")) {
      const [eventId] = params as [string];
      return (t) => {
        if (t.inbox.includes(eventId)) return { rows: [], rowCount: 0 };
        t.inbox.push(eventId);
        return { rows: [], rowCount: 1 };
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
        flow_approval_id: null,
        flow_approval_at: null,
        created_at: now,
        updated_at: now,
      };
      return (t) => {
        t.notes.push({ ...row });
        return { rows: [{ ...row }] };
      };
    }
    if (sql.startsWith("UPDATE")) {
      const [author, id, value] = params;
      // Only the columns the statement sets, on the row as it is where the change is applied (row-level, as in Postgres).
      const set: Record<string, unknown> = sql.includes("flow_approval_id = $3")
        ? { flow_approval_id: value, flow_approval_at: new Date() }
        : sql.includes("issue_url =")
          ? {
              issue_url: value,
              updated_at: new Date(),
              ...(sql.includes("flow_approval_id = NULL") ? { flow_approval_id: null, flow_approval_at: null } : {}),
            }
          : { body: value, updated_at: new Date() };
      return (t) => {
        const row = t.notes.find((r) => r.id === id && r.author === author);
        if (row) Object.assign(row, set);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      };
    }
    if (sql.startsWith("DELETE")) {
      const [author, id] = params;
      return (t) => {
        const i = t.notes.findIndex((r) => r.id === id && r.author === author);
        if (i !== -1) t.notes.splice(i, 1);
        return { rows: [], rowCount: i === -1 ? 0 : 1 };
      };
    }
    return undefined;
  };

  const read = (t: Tables, sql: string, params: unknown[]) => {
    if (sql.includes("CREATE TABLE")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT")) {
      if (sql.includes("FOR UPDATE") || sql.includes("WHERE id = $2 AND author = $1")) {
        const [author, id] = params;
        return { rows: t.notes.filter((r) => r.author === author && r.id === id).map((r) => ({ ...r })) };
      }
      const [author, doc] = params;
      return {
        rows: t.notes.filter((r) => r.author === author && (doc === null || r.doc_path === doc)).map((r) => ({ ...r })),
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };

  const query = async (sql: string, params: unknown[] = []) => {
    record(sql, params);
    return change(sql, params)?.(committed) ?? read(committed, sql, params);
  };

  const connect = async () => {
    let tx: Tables | undefined;
    let pending: Change[] = [];
    return {
      async query(sql: string, params: unknown[] = []) {
        record(sql, params);
        if (sql === "BEGIN") {
          tx = copy(committed);
          pending = [];
          return { rows: [] };
        }
        if (sql === "COMMIT") {
          // The transaction's writes, applied to what is committed now (others may have committed meanwhile).
          for (const c of pending) c(committed);
          tx = undefined;
          pending = [];
          return { rows: [] };
        }
        if (sql === "ROLLBACK") {
          tx = undefined;
          pending = [];
          return { rows: [] };
        }
        const c = change(sql, params);
        if (!c) return read(tx ?? committed, sql, params);
        if (tx) pending.push(c);
        return c(tx ?? committed);
      },
      release() {},
    };
  };

  db.pool = { query, connect } as never;
  return db;
}
