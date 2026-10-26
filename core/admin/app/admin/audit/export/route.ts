/**
 * The Audit pages' "Export CSV": the same filters as the page, up to 2 000 events, newest first, as a download.
 * Checked like every page (an administrator, per request); nothing is cached. Cells that a spreadsheet would run
 * as a formula are neutralised (lib/audit.ts csvCell).
 */
import { actorName, dayAfter, describeChange, describeSignIn, methodLabel, SIGN_IN_KINDS, toCsv } from "@/lib/audit";
import { changeFilters, signInFilters } from "@/lib/audit-filters";
import { coreApi } from "@/lib/core-api";
import { identityApi, trailState } from "@/lib/identity-api";
import { adminState } from "@/lib/session";

export const dynamic = "force-dynamic";

const MAX_ROWS = 2000;
const PAGE = 200;

function csv(name: string, body: string) {
  const day = new Date().toISOString().slice(0, 10);
  return new Response(`\uFEFF${body}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="asafarim-${name}-${day}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(req: Request) {
  const s = await adminState();
  if (s.state === "signed-out") return Response.json({ error: "unauthorized" }, { status: 401 });
  if (s.state === "forbidden") return Response.json({ error: "forbidden" }, { status: 403 });
  const params = Object.fromEntries(new URL(req.url).searchParams);

  if (params.source === "changes") {
    const f = changeFilters(params);
    const api = coreApi(s.idToken);
    const rows: unknown[][] = [];
    let before = f.before;
    while (rows.length < MAX_ROWS) {
      const page = await api.audit({
        ...(f.app ? { app: f.app } : {}),
        ...(f.actor ? { actor: f.actor } : {}),
        ...(f.action ? { action: f.action } : {}),
        ...(f.involving ? { involving: f.involving } : {}),
        ...(f.from ? { since: f.from } : {}),
        ...(f.to ? { until: dayAfter(f.to) } : {}),
        ...(before ? { before } : {}),
        limit: PAGE,
      });
      for (const e of page.events)
        rows.push([
          e.id,
          e.at,
          e.actor,
          actorName(e.actor),
          e.action,
          e.appId ?? "",
          describeChange(e).sentence,
          e.detail,
        ]);
      if (!page.next) break;
      before = page.next;
    }
    return csv(
      "admin-changes",
      toCsv(
        ["id", "at_utc", "actor", "actor_name", "action", "app", "what_happened", "detail_json"],
        rows.slice(0, MAX_ROWS),
      ),
    );
  }

  if (params.source === "sign-ins") {
    const f = signInFilters(params);
    const kind = SIGN_IN_KINDS.find((k) => k.value === f.kind);
    const api = identityApi(s.idToken);
    const rows: unknown[][] = [];
    let before = f.before;
    try {
      while (rows.length < MAX_ROWS) {
        const page = await api.audit({
          ...(kind ? { events: kind.events } : {}),
          ...(f.method ? { method: f.method } : {}),
          ...(f.principal ? { principal: f.principal } : {}),
          ...(f.handle ? { handle: f.handle } : {}),
          ...(f.from ? { since: f.from } : {}),
          ...(f.to ? { until: dayAfter(f.to) } : {}),
          ...(before ? { before } : {}),
          limit: PAGE,
        });
        for (const e of page.events)
          rows.push([
            e.id,
            e.at,
            e.event,
            e.principalId ?? "",
            e.label ?? "",
            methodLabel(e.method),
            describeSignIn(e).sentence,
            e.actorLabel ?? e.actorId ?? "",
            e.ipHandle ?? "",
            e.subjectHandle ?? "",
            e.detail,
          ]);
        if (!page.next) break;
        before = page.next;
      }
    } catch (err) {
      const state = trailState(err);
      return Response.json({ error: state }, { status: state === "not-admin" ? 403 : 503 });
    }
    return csv(
      "sign-ins",
      toCsv(
        [
          "id",
          "at_utc",
          "event",
          "principal_id",
          "person",
          "method",
          "what_happened",
          "decided_by",
          "address_fingerprint",
          "identifier_fingerprint",
          "detail_json",
        ],
        rows.slice(0, MAX_ROWS),
      ),
    );
  }

  return Response.json({ error: "bad_request", message: "source must be changes or sign-ins" }, { status: 400 });
}
