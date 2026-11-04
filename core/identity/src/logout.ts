/** Notify registered RPs after local identity sign-out/revocation has invalidated provider state. */
import type { Provider } from "oidc-provider";
import type { Logger } from "./log.ts";

export interface EndedProviderSession {
  accountId: string;
  authorizations?: Record<string, { sid?: string; grantId?: string }>;
}

export async function notifySessionLogout(
  provider: Provider,
  session: EndedProviderSession,
  log?: Pick<Logger, "warn">,
): Promise<void> {
  await Promise.all(
    Object.entries(session.authorizations ?? {}).map(async ([clientId, { sid }]) => {
      try {
        const client = await provider.Client.find(clientId);
        if (
          !client?.backchannelLogoutUri ||
          (client.backchannelLogoutSessionRequired && !sid) ||
          typeof client.backchannelLogout !== "function"
        )
          return;
        const send = client.backchannelLogout as (subject: string, sid?: string) => Promise<void>;
        await send.call(client, session.accountId, sid);
      } catch (error) {
        // Provider revocation is already committed; an unreachable RP must not undo or prevent it.
        log?.warn("logout.backchannel_failed", {
          clientId,
          errorCode: error instanceof Error ? error.name : "delivery_failed",
        });
      }
    }),
  );
}
