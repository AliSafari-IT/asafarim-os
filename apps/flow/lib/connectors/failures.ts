/**
 * How the connectors report what lib/egress refused or couldn't do: the egress code as the step's error
 * code (the host named, never the URL), retryable when trying again may help.
 */
import { ConnectorError } from "../engine/connector-error";
import { EgressError, type EgressErrorCode } from "../egress/egress";

const MESSAGES: Record<EgressErrorCode, string> = {
  invalid_url: "The URL isn't valid.",
  scheme_refused: "Only https:// is allowed.",
  userinfo_refused: "A URL with a user name or password is refused.",
  port_refused: "The port isn't allowed for this host.",
  host_not_allowed: "The host isn't on the allow-list.",
  dns_failed: "The host name didn't resolve.",
  address_refused: "The host resolves to a private or reserved address.",
  request_too_large: "The request is larger than 256 KiB.",
  response_too_large: "The answer is larger than 1 MiB.",
  redirect_refused: "The server answered with a redirect, which isn't followed.",
  timeout: "No answer in time.",
  connect_failed: "The connection failed.",
  paused_all: "Flow is paused (Settings): nothing is sent.",
};

/**
 * An EgressError as a ConnectorError: a failure that may pass (no answer, the connection or DNS failed)
 * retryable, as `unavailable` (e.g. github_unavailable) when given; otherwise the egress code itself,
 * `address_refused` as `private_address`, not retryable. Anything else is rethrown.
 */
export function egressFailure(err: unknown, unavailable?: string): never {
  if (!(err instanceof EgressError)) throw err;
  const host = err.host ? ` (${err.host})` : "";
  const message = `${MESSAGES[err.code]}${host}`;
  if (err.code === "timeout" || err.code === "connect_failed" || err.code === "dns_failed")
    throw new ConnectorError(unavailable ?? err.code, true, message);
  if (err.code === "address_refused") throw new ConnectorError("private_address", false, message);
  throw new ConnectorError(err.code, false, message);
}
