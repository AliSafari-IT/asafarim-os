/**
 * Typed errors. Every error carries a stable `code`, an HTTP `status` hint and, where it helps, a short `reason`
 * from a closed list. Messages are fixed strings: they never contain a token, a code, a session id, a state value,
 * a URL or any other input, so an error can be logged or serialised without leaking anything. `toJSON` is explicit
 * for the same reason.
 */
export class AuthRuntimeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reason: string | undefined;

  constructor(code: string, message: string, status: number, reason?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.reason = reason;
  }

  toJSON(): { name: string; code: string; status: number; reason?: string } {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}

export class InvalidConfigError extends AuthRuntimeError {
  constructor(what: string) {
    super("invalid_config", `Invalid auth runtime configuration: ${what}`, 500);
  }
}

/** The callback does not belong to a flow this browser started (missing, used, expired or mismatched state). */
export class InvalidStateError extends AuthRuntimeError {
  constructor(reason: "missing_flow" | "expired_flow" | "state_mismatch" | "bad_callback") {
    super("invalid_state", "The sign-in could not be completed", 400, reason);
  }
}

export class InvalidReturnTargetError extends AuthRuntimeError {
  constructor() {
    super("invalid_return_target", "The return target is not allowed", 400);
  }
}

export type TokenValidationReason =
  "issuer" | "audience" | "signature" | "expired" | "nonce" | "auth_time" | "alg" | "claims";

export class TokenValidationError extends AuthRuntimeError {
  constructor(reason: TokenValidationReason) {
    super("token_validation", "The identity provider's token was not accepted", 401, reason);
  }
}

export class LogoutTokenInvalidError extends AuthRuntimeError {
  constructor() {
    super("logout_token_invalid", "The logout token was not accepted", 400);
  }
}

export class LogoutReplayError extends AuthRuntimeError {
  constructor() {
    super("logout_replay", "The logout token was already used", 400);
  }
}

export type SessionExpiredReason = "absolute" | "idle" | "revoked" | "refresh_failed" | "token_expired";

export class SessionExpiredError extends AuthRuntimeError {
  constructor(reason: SessionExpiredReason) {
    super("session_expired", "The session has ended", 401, reason);
  }
}

/** No session at all: the caller must sign in. */
export class AuthenticationRequiredError extends AuthRuntimeError {
  constructor() {
    super("authentication_required", "Sign-in is required", 401);
  }
}

/** The session's authentication is older than the freshness bound: sign in again (`start({ fresh: true })`). */
export class StepUpRequiredError extends AuthRuntimeError {
  constructor(readonly restartUrl?: string) {
    super("step_up_required", "A recent sign-in is required", 401);
  }
  override toJSON() {
    return { ...super.toJSON(), ...(this.restartUrl ? { restartUrl: this.restartUrl } : {}) };
  }
}

/** The identity provider could not be reached or answered with a server error. The session is kept. */
export class IdentityUnavailableError extends AuthRuntimeError {
  constructor() {
    super("identity_unavailable", "The identity provider is unavailable", 503);
  }
}

/** The provider answered, and said no (invalid_grant, invalid_token, 401): the session cannot continue. */
export class ProviderRejectedError extends AuthRuntimeError {
  constructor(reason: "invalid_grant" | "invalid_token" | "subject_mismatch" | "client_rejected") {
    super("provider_rejected", "The identity provider rejected the request", 401, reason);
  }
}

/** The provider redirected back with an OAuth error (for example the person declined, or the account is not allowed). */
export class AuthorizationError extends AuthRuntimeError {
  constructor(reason: string) {
    super("authorization_error", "The identity provider did not authorise the sign-in", 403, reason);
  }
}

export class StoreUnavailableError extends AuthRuntimeError {
  constructor() {
    super("store_unavailable", "The session store is unavailable", 503);
  }
}

export class StoreCorruptError extends AuthRuntimeError {
  constructor() {
    super("store_corrupt", "A stored record failed its integrity check", 500);
  }
}

export class RefreshBusyError extends AuthRuntimeError {
  constructor() {
    super("refresh_busy", "A token refresh is in progress", 503);
  }
}

export class RefreshOwnershipLostError extends AuthRuntimeError {
  constructor() {
    super("refresh_ownership_lost", "The refresh lock was lost before the result could be saved", 503);
  }
}

export class ProfileDeniedError extends AuthRuntimeError {
  constructor(reason = "denied") {
    super("profile_denied", "This account is not allowed here", 403, reason);
  }
}

export class CsrfError extends AuthRuntimeError {
  constructor() {
    super("csrf", "The request was not accepted", 403);
  }
}

export class PayloadTooLargeError extends AuthRuntimeError {
  constructor() {
    super("payload_too_large", "The request body is too large", 413);
  }
}

export class RateLimitedError extends AuthRuntimeError {
  constructor() {
    super("rate_limited", "Too many requests", 429);
  }
}
