/**
 * The one decision that says whether a person may use a client (#341).
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

/** `restricted` (the default): an admin decides. `public`: proving an identifier at this client is enough. */
export type AdmissionPolicy = "public" | "restricted";

export const ADMISSION_POLICIES: readonly AdmissionPolicy[] = ["public", "restricted"];

export interface AdmissionSubject {
  /** connections.status = 'revoked'. */
  suspended: boolean;
  /** connections.status = 'active': access to every client, granted by an admin or the bootstrap. */
  globalActive: boolean;
  /** Clients this person was admitted to by a public policy (client_admissions). */
  admittedClients: readonly string[];
}

export type Decision = { allow: true; via: "connection" | "public_admission" } | { allow: false; reason: DenyReason };

export type DenyReason = "unknown" | "suspended" | "no_access" | "out_of_scope";

export function decide(subject: AdmissionSubject | null, clientId: string | null): Decision {
  if (subject === null) return { allow: false, reason: "unknown" };
  if (subject.suspended) return { allow: false, reason: "suspended" };
  if (subject.globalActive) return { allow: true, via: "connection" };
  if (clientId !== null && subject.admittedClients.includes(clientId)) return { allow: true, via: "public_admission" };
  return { allow: false, reason: subject.admittedClients.length > 0 ? "out_of_scope" : "no_access" };
}

/**
 * An admission only counts while the client's CURRENT policy is `public`: a client that goes back to
 * `restricted` stops honouring the admissions it handed out, without touching the database.
 */
export function currentAdmissions(admitted: readonly string[], policyOf: (clientId: string) => AdmissionPolicy) {
  return admitted.filter((id) => policyOf(id) === "public");
}
