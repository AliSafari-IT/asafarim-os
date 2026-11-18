/**
 * Token budgets for AI assistance (#360): a monthly cap for the publication and one per author. A request reserves
 * its worst case (input estimate + max output) before the call, under row locks in one transaction, so concurrent
 * requests can't overspend; afterwards it settles the reservation to the tokens the API reported.
 */
import type pg from "pg";

type Pool = Pick<pg.Pool, "connect" | "query">;

export const PUBLICATION = "*";

/** The budget month of `now` in UTC, e.g. "2026-11". */
export const monthOf = (now: Date) => now.toISOString().slice(0, 7);

export interface Caps {
  monthlyTokenCap: number;
  authorMonthlyTokenCap: number;
}

export type Reservation = { ok: true; month: string; tokens: number } | { ok: false; scope: "publication" | "author" };

export async function reserve(
  pool: Pool,
  subject: string,
  tokens: number,
  caps: Caps,
  now = new Date(),
): Promise<Reservation> {
  const month = monthOf(now);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Always in the same order (publication, then author), so two requests never deadlock.
    const rows: Record<string, { reserved: string; used: string }> = {};
    for (const s of [PUBLICATION, subject]) {
      await client.query("INSERT INTO ai_usage (month, subject) VALUES ($1, $2) ON CONFLICT DO NOTHING", [month, s]);
      const r = await client.query<{ reserved: string; used: string }>(
        "SELECT reserved, used FROM ai_usage WHERE month = $1 AND subject = $2 FOR UPDATE",
        [month, s],
      );
      rows[s] = r.rows[0]!;
    }
    const spent = (s: string) => Number(rows[s]!.reserved) + Number(rows[s]!.used);
    const over =
      spent(PUBLICATION) + tokens > caps.monthlyTokenCap
        ? "publication"
        : spent(subject) + tokens > caps.authorMonthlyTokenCap
          ? "author"
          : null;
    if (over) {
      await client.query("ROLLBACK");
      return { ok: false, scope: over };
    }
    await client.query("UPDATE ai_usage SET reserved = reserved + $3 WHERE month = $1 AND subject = ANY($2::text[])", [
      month,
      [PUBLICATION, subject],
      tokens,
    ]);
    await client.query("COMMIT");
    return { ok: true, month, tokens };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Replace a reservation with what the call actually used (0 when it never reached the API). */
export async function settle(
  pool: Pick<Pool, "query">,
  subject: string,
  r: { month: string; tokens: number },
  used: number,
) {
  await pool.query(
    `UPDATE ai_usage SET reserved = GREATEST(reserved - $3, 0), used = used + $4
     WHERE month = $1 AND subject = ANY($2::text[])`,
    [r.month, [PUBLICATION, subject], r.tokens, Math.max(0, Math.round(used))],
  );
}

/** What is left this month, for the studio to show. */
export async function remaining(pool: Pick<Pool, "query">, subject: string, caps: Caps, now = new Date()) {
  const { rows } = await pool.query<{ subject: string; spent: string }>(
    "SELECT subject, (reserved + used)::text AS spent FROM ai_usage WHERE month = $1 AND subject = ANY($2::text[])",
    [monthOf(now), [PUBLICATION, subject]],
  );
  const spent = (s: string) => Number(rows.find((r) => r.subject === s)?.spent ?? 0);
  return Math.max(0, Math.min(caps.monthlyTokenCap - spent(PUBLICATION), caps.authorMonthlyTokenCap - spent(subject)));
}
