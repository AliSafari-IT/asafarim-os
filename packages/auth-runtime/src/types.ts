/** Shared types. No runtime code here. */

/** The identity key: the issuer that vouched for the subject, and the subject. Never an e-mail address. */
export interface IdentityKey {
  readonly iss: string;
  readonly sub: string;
}

/**
 * What the runtime validated from the ID token. Hooks receive this (no tokens). `emailHint` is informational only:
 * nothing in the runtime looks anything up, or links an account, by e-mail.
 */
export interface ValidatedClaims {
  readonly identityKey: IdentityKey;
  readonly sid?: string;
  /** Seconds since the epoch: when the person last proved who they are, from the verified ID token. */
  readonly authTime: number;
  /** Seconds since the epoch: when the ID token was issued. */
  readonly issuedAt: number;
  /** Authentication methods / class, only ever from the verified ID token. */
  readonly amr?: readonly string[];
  readonly acr?: string;
  readonly emailHint?: string;
}

/** Validated claims plus the tokens the code exchange returned. Server-side only. */
export interface ValidatedIdentity extends ValidatedClaims {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Seconds. */
  readonly expiresIn: number;
}

export interface SessionBounds {
  /** Hard cap, counted from `auth_time`. */
  absoluteMs: number;
  /** Sliding bound; null = no idle bound. */
  idleMs: number | null;
  /** How old `auth_time` may be for a step-up-guarded action. */
  freshMs: number;
  /** Maximum age of the last positive provider check (userinfo or refresh) before a new one is required. */
  revalidateMs: number;
  /** Refresh the access token when it expires within this many ms. Default 10 000. */
  refreshSkewMs?: number;
  /** Refresh lock lease. Default 30 000. */
  refreshLeaseMs?: number;
  /** Extra time logout markers outlive the absolute bound. Default 300 000. */
  logoutMarkerSlackMs?: number;
}

export interface ResolvedBounds extends Required<Omit<SessionBounds, "idleMs">> {
  idleMs: number | null;
}

/** The persisted session. Tokens live here and nowhere else. */
export interface StoredSession {
  readonly version: 1;
  readonly identityKey: IdentityKey;
  readonly sid?: string;
  /** Seconds. */
  readonly authTime: number;
  /** Milliseconds: when this session was created. */
  readonly issuedAt: number;
  /** Milliseconds: hard end of the session (`authTime` + absolute bound). */
  readonly expiresAt: number;
  readonly amr?: readonly string[];
  readonly acr?: string;
  readonly emailHint?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Milliseconds. */
  readonly accessExpiresAt: number;
  /** Milliseconds: the last positive provider check. */
  readonly lastCheckedAt: number;
  readonly csrf: string;
  /** App-owned data returned by `onSignIn`. */
  readonly app?: unknown;
}

/** A server-side record of a sign-in in progress. Single use. */
export interface Flow {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly returnTo: string;
  readonly locale?: string;
  readonly intent?: string;
  readonly fresh: boolean;
  /** Milliseconds. */
  readonly createdAt: number;
}

export type StoreReadResult =
  { status: "ok"; session: StoredSession } | { status: "missing" | "expired" | "idle" | "revoked" };

export interface LockToken {
  readonly token: string;
}

export interface LogoutRecord {
  readonly jti: string;
  /** Seconds, from the logout token. */
  readonly iat: number;
  readonly sid?: string;
  readonly sub?: string;
  /** How long the replay guard and the revocation markers must live. */
  readonly ttlMs: number;
}

/**
 * Where sessions live. App/infrastructure-owned; the runtime depends only on this contract (see the contract tests
 * in `test/store-contract.ts` for the exact atomic semantics every implementation must have).
 */
export interface SessionStore {
  /** Atomic read. `touch` slides the idle window. Applies the absolute, idle and logout-marker checks and deletes a dead record. */
  get(id: string, o: { touch: boolean; idleMs: number | null; now: number }): Promise<StoreReadResult>;
  /** Create. Returns false when a logout for this subject or session arrived at or after `issuedAt` (revoked meanwhile). */
  create(id: string, s: StoredSession, o: { now: number }): Promise<boolean>;
  /** Replace the record, only while `lock` is still held and the session still exists and is not revoked. */
  update(id: string, s: StoredSession, lock: LockToken, o: { now: number }): Promise<boolean>;
  destroy(id: string): Promise<void>;
  acquireRefresh(id: string, leaseMs: number): Promise<LockToken | null>;
  renewRefresh(id: string, lock: LockToken, leaseMs: number): Promise<boolean>;
  releaseRefresh(id: string, lock: LockToken): Promise<void>;
  /** Replay-guard the `jti` and write revocation markers. Returns false when the `jti` was already seen. */
  recordLogout(r: LogoutRecord): Promise<boolean>;
}

export interface FlowStore {
  put(id: string, flow: Flow, ttlMs: number): Promise<void>;
  /** Single use: returns the flow once, then null. */
  take(id: string): Promise<Flow | null>;
}

/** What `authorize` and `onSignIn` see: claims and app data, never tokens (unless `needsTokens`). */
export interface SessionView extends ValidatedClaims {
  readonly app?: unknown;
  readonly tokens?: { readonly accessToken: string };
}

export type SignInDecision<A = unknown> = { allow: true; app?: A } | { allow: false; reason: string };

/** App-owned hooks. Domain grants, memberships, workspace rules and profile fields stay outside the runtime. */
export interface ProfileHooks<A = unknown> {
  /** After the ID token is validated, before a session exists. */
  onSignIn?(claims: ValidatedClaims, tokens?: { accessToken: string }): Promise<SignInDecision<A>>;
  /**
   * Evaluated on EVERY `state()` / `require()` call, never cached by the runtime. `policy` is `"access"` for the app-wide
   * gate or one of the policy names registered at construction.
   */
  authorize?(session: SessionView, policy: string): Promise<boolean>;
  /** Extra liveness check for the app's own account state (for example a headless principal). */
  revalidate?(session: SessionView): Promise<{ active: boolean }>;
}

export interface RuntimeDeps {
  /** Milliseconds. Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Return false to refuse (rate limit). */
  budget?: (name: string, key: string) => Promise<boolean>;
  audit?: (event: string, detail: Record<string, string | number | boolean | undefined>) => void;
  /** Log lines contain only event names and error codes, never tokens, ids or URLs. */
  log?: (line: { event: string; code?: string }) => void;
}

export interface SessionState {
  status: "anonymous" | "active" | "unauthorized";
  sub?: string;
  displayHint?: string;
  authorized: Record<string, boolean>;
  fresh: boolean;
}
