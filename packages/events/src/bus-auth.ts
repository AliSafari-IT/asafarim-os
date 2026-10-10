/**
 * How a client signs in to the event bus (P4.1 PR 4). The bus checks identities through core-api
 * (NATS auth callout): the user is the app id and the password is a signed, single-use assertion,
 * so it must be computed again on EVERY connect and reconnect. @asafarim/app-sdk builds one from
 * the app's registry credential; this package never sees the credential itself.
 */
import { usernamePasswordAuthenticator } from "@nats-io/nats-core";
import type { Authenticator } from "@nats-io/nats-core";

export interface BusAuth {
  user: string;
  /** Called for every connect and reconnect: returns a fresh password each time. */
  pass: () => string;
  /**
   * The client's inbox prefix. A bus that gives each app its own inbox namespace (P4.1 PR 4) lets the
   * app subscribe to nothing else, so replies must arrive under it. Unset = the NATS default `_INBOX`.
   */
  inboxPrefix?: string;
}

/** The connect options a BusAuth adds: the authenticator and, if set, the inbox prefix. */
export const busConnectOptions = (auth: BusAuth) => ({
  authenticator: busAuthenticator(auth),
  // The default gives up reconnecting after repeated authorization errors, which a restarting auth
  // callout produces; the relay and subscriber hold one connection for life, so keep retrying.
  ignoreAuthErrorAbort: true,
  ...(auth.inboxPrefix ? { inboxPrefix: auth.inboxPrefix } : {}),
});

export const busAuthenticator = (auth: BusAuth): Authenticator => usernamePasswordAuthenticator(auth.user, auth.pass);
