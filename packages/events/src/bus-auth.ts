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
}

export const busAuthenticator = (auth: BusAuth): Authenticator => usernamePasswordAuthenticator(auth.user, auth.pass);
