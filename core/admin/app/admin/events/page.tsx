import Link from "next/link";
import { coreApi } from "@/lib/core-api";
import {
  MAX_QUERY_LENGTH,
  type MatchField,
  catalogFor,
  entryFlags,
  eventsAppFilter,
  eventsQuery,
  schemaText,
  searchCatalog,
} from "@/lib/events";
import { requireAdmin } from "@/lib/session";
import { formatTime } from "@/lib/util";

export const dynamic = "force-dynamic";
export const metadata = { title: "Events · Admin · ASafariM OS" };

const SCHEMA_STATUS: Record<string, string> = {
  provided: "Schema provided",
  not_provided: "no schema uploaded",
  no_publisher: "no publisher",
};

const MATCHED: Record<MatchField, string> = {
  type: "type",
  app: "app",
  description: "description",
  property: "schema property",
};

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const app = eventsAppFilter(params.app);
  const q = eventsQuery(params.q);

  const api = coreApi(admin.idToken);
  const [listed, all] = await Promise.all([api.apps(), api.events()]);
  // A removed app publishes and subscribes to nothing: not a filter choice.
  const apps = listed.filter((a) => a.state !== "removed");
  const inApp = catalogFor(all, app);
  // P7.4 part 1: keyword search, best match first; without ?q= the catalog keeps its type order.
  const hits = q ? searchCatalog(inApp, q) : inApp.map((entry) => ({ entry, matched: [] as MatchField[] }));
  const entries = hits.map((h) => h.entry);

  return (
    <>
      <h2>Events</h2>
      <p className="muted">
        Every event type an installed app publishes or subscribes to: who publishes it, its schema, and who listens.
        Apps declare these in their manifests; publishers upload the schemas. Search by words in the type, an app id, or
        the schema&apos;s descriptions and properties, e.g. &ldquo;order shipped&rdquo;.
      </p>
      <form method="get" className="card row" aria-label="Filter the event catalog">
        <div>
          <label htmlFor="events-app">App</label>
          <select id="events-app" name="app" defaultValue={app ?? ""}>
            <option value="">All apps</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="events-q">Search</label>
          <input
            id="events-q"
            name="q"
            type="search"
            defaultValue={q ?? ""}
            maxLength={MAX_QUERY_LENGTH}
            placeholder="e.g. order shipped"
          />
        </div>
        <button type="submit">Filter</button>
        {app || q ? (
          <Link href="/admin/events" className="muted">
            Clear
          </Link>
        ) : null}
      </form>

      {entries.length === 0 ? (
        <p className="muted" data-testid="events-empty">
          {q
            ? `No event type matches “${q}”${app ? ` among those ${app} publishes or subscribes to` : ""}.`
            : app
              ? `${app} publishes and subscribes to no event types.`
              : "No app publishes or subscribes to any event yet."}
        </p>
      ) : (
        <div className="table-wrap os-table-wrap">
          <table className="os-table os-table--stack">
            <caption>
              {entries.length} event type{entries.length === 1 ? "" : "s"}
              {app ? ` that ${app} publishes or subscribes to` : ""}
              {q ? ` matching “${q}”, best match first` : ""}
            </caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Publisher</th>
                <th scope="col">Schema</th>
                <th scope="col">Subscribers</th>
              </tr>
            </thead>
            <tbody>
              {hits.map(({ entry: e, matched }) => {
                const flags = entryFlags(e);
                return (
                  <tr key={e.type} data-testid={`event-${e.type}`}>
                    <th scope="row" className="mono">
                      {e.type}
                      {matched.length > 0 ? (
                        <div className="muted" data-testid={`matched-${e.type}`}>
                          Matched: {matched.map((m) => MATCHED[m]).join(", ")}
                        </div>
                      ) : null}
                    </th>
                    <td data-label="Publisher" data-testid={`publisher-${e.type}`}>
                      {e.publisher ? (
                        <span className="mono">
                          {e.publisher.appId} · v{e.publisher.version}
                        </span>
                      ) : (
                        <span className="badge warn">No publisher</span>
                      )}
                    </td>
                    <td data-label="Schema">
                      <span
                        className={e.schemaStatus === "provided" ? "" : "muted"}
                        data-testid={`schema-status-${e.type}`}
                      >
                        {SCHEMA_STATUS[e.schemaStatus] ?? e.schemaStatus}
                      </span>
                      {e.schema !== null ? (
                        <details className="schema" data-testid={`schema-${e.type}`}>
                          <summary>
                            Show schema
                            {e.schemaAppVersion ? ` (from v${e.schemaAppVersion}` : ""}
                            {e.schemaAppVersion && e.schemaUpdatedAt ? `, ${formatTime(e.schemaUpdatedAt)}` : ""}
                            {e.schemaAppVersion ? ")" : ""}
                          </summary>
                          <pre>{schemaText(e.schema)}</pre>
                        </details>
                      ) : null}
                    </td>
                    <td data-label="Subscribers">
                      {e.subscribers.length === 0 ? (
                        <span className="muted">None</span>
                      ) : (
                        <ul className="subscribers">
                          {e.subscribers.map((s) => (
                            <li key={s.appId} data-testid={`subscriber-${e.type}-${s.appId}`}>
                              <span className="mono">{s.appId}</span> <span className="muted mono">{s.handler}</span>{" "}
                              {s.consumer === "waiting_for_publisher" ? (
                                <span className="badge warn">Waiting for publisher</span>
                              ) : (
                                <span className="badge active">Bound</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {flags.noPublisher && e.subscribers.length > 0 ? (
                        <div className="muted">
                          No installed app publishes this event yet; delivery starts when one is installed.
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
