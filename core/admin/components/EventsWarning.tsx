/**
 * The event subscriptions of an app whose publisher isn't installed (P4.1): a warning, not an
 * error. Nothing is blocked; core-api creates the durable consumer when the publisher is installed.
 */
export function EventsWarning({ appId, types }: { appId: string; types: string[] }) {
  if (types.length === 0) return null;
  return (
    <div className="events-warning" data-testid={`events-warning-${appId}`}>
      <span className="badge warn">Waiting for publisher</span>{" "}
      <span className="muted">
        No installed app publishes {types.length === 1 ? "this event" : "these events"} yet; delivery starts when one is
        installed:
      </span>
      <ul>
        {types.map((t) => (
          <li key={t} className="mono">
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}
