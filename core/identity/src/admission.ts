/**
 * The one decision that says whether an account may use a client (#341), for local and Hub mode alike.
 *
 * Every gate that used to ask "is the connection active?" (sign-in completion, an existing session at
 * /interaction, findAccount for codes, tokens, refresh and userinfo) asks `decide` instead, so a rule
 * can't be applied at one gate and forgotten at another. It is pure: no I/O, no clock.
 *
 * Order is fixed:
 *   1. unknown person                         → deny (`unknown`)
 *   2. suspended (a revoked connection)       → deny (`suspended`). This beats everything below.
 *   3. a global connection (admin/bootstrap)  → allow, for every client
 *   4. an admission for THIS client           → allow, for that client only
 *   5. otherwise                              → deny (`out_of_scope` if they hold admissions elsewhere, else `no_access`)
 *
 * An unknown client (null) can only be satisfied by step 3, so it fails closed for people who hold
 * admissions only.
 */

import type { AccountAccess } from "./accounts.ts";

/** `restricted` (the default): an admin decides. `public`: proving an identifier at this client is enough. */
export type AdmissionPolicy = "public" | "restricted";

export const ADMISSION_POLICIES: readonly AdmissionPolicy[] = ["public", "restricted"];

export type Decision = { allow: true; via: "connection" | "public_admission" } | { allow: false; reason: DenyReason };

export type DenyReason = "unknown" | "suspended" | "no_access" | "out_of_scope";

/** The decision on an account for one client. Pure. `null` for either input fails closed for per-client access. */
export function decide(account: AccountAccess | null, clientId: string | null): Decision {
  if (account === null || account.state === "deleted") return { allow: false, reason: "unknown" };
  if (account.state !== "active") return { allow: false, reason: "suspended" };
  if (account.globalAccess) return { allow: true, via: "connection" };
  if (clientId !== null && account.admittedClients.includes(clientId)) return { allow: true, via: "public_admission" };
  return { allow: false, reason: account.admittedClients.length > 0 ? "out_of_scope" : "no_access" };
}

/** What a sign-in came to, in the names S0 §2 fixed. `reason` is the typed outcome; the finer cause stays in the audit. */
export type SignInOutcome =
  | { kind: "admitted"; subject: "new" | "existing"; via: "connection" | "public_admission" }
  | { kind: "denied"; reason: "suspended" | "restricted_client_denied" | "unknown_account" | "needs_verification" }
  | { kind: "conflict"; reason: "identifier_conflict" };

export function outcomeOf(decision: Decision, created: boolean): SignInOutcome {
  if (decision.allow) return { kind: "admitted", subject: created ? "new" : "existing", via: decision.via };
  switch (decision.reason) {
    case "suspended":
      return { kind: "denied", reason: "suspended" };
    case "unknown":
      return { kind: "denied", reason: "unknown_account" };
    default:
      return { kind: "denied", reason: "restricted_client_denied" };
  }
}

/**
 * An admission only counts while the client's CURRENT policy is `public`: a client that goes back to
 * `restricted` stops honouring the admissions it handed out, without touching the database.
 */
export function currentAdmissions(admitted: readonly string[], policyOf: (clientId: string) => AdmissionPolicy) {
  return admitted.filter((id) => policyOf(id) === "public");
}

/** The account as the clients' current policies see it (see currentAdmissions). */
export function underPolicies(account: AccountAccess, policyOf: (clientId: string) => AdmissionPolicy): AccountAccess {
  return { ...account, admittedClients: currentAdmissions(account.admittedClients, policyOf) };
}
