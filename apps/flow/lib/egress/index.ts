/** lib/egress: the only way Flow calls out (egress.ts). */
export { createEgress, EgressError, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, TIMEOUT_MS } from "./egress";
export type { Egress, EgressErrorCode, EgressRequest, EgressResponse } from "./egress";
export { allowListOf, isAllowed, parseHostEntry, type AllowedHost } from "./hosts";
export { isBlockedAddress } from "./address";

import { createEgress } from "./egress";

/** Flow's egress: the system resolver, the system's trust store. */
export const egress = createEgress();
