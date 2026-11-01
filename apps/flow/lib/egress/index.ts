/** lib/egress: the only way Flow calls out (egress.ts; email: smtp.ts). */
// The factories (createEgress, createSmtpEgress) stay inside this folder: they take routes and resolvers.
export { EgressError, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_TIMEOUT_MS, TIMEOUT_MS } from "./egress";
export type { Egress, EgressErrorCode, EgressRequest, EgressResponse } from "./egress";
export { allowListOf, isAllowed, parseHostEntry, type AllowedHost } from "./hosts";
export { isBlockedAddress } from "./address";
export { SmtpEgressError, type MailRequest, type SmtpEgress, type SmtpEgressErrorCode } from "./smtp";

import { log } from "../log";
import { BUILT_FOR_E2E, e2eEgress } from "./e2e";
import { createEgress } from "./egress";
import { createSmtpEgress } from "./smtp";

/** The end-to-end tests' local routes (e2e.ts), only when FLOW_E2E_EGRESS is set. */
const e2e = e2eEgress();
if (e2e) log.warn("flow.egress.e2e_routes", { hosts: e2e.hosts });
// Given to a build that wasn't made for the e2e: ignored, and said so (nothing but the e2e sets it).
else if (!BUILT_FOR_E2E && process.env.FLOW_E2E_EGRESS?.trim())
  log.warn("flow.egress.e2e_refused", { reason: "not an e2e build" });
const routed = e2e ? { route: e2e.route } : {};

/** Flow's egress: the system resolver, the system's trust store. */
export const egress = createEgress(routed);
/** Email out, with the same checks (smtp.ts). */
export const smtpEgress = createSmtpEgress(routed);
