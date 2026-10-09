/**
 * core-api's error codes: the `error` field of every non-2xx JSON response.
 * Stable: clients (the CLI, the app SDK) branch on them. See README "Errors".
 */
export const ERRORS = {
  unauthorized: 401, //            admin endpoints: missing or wrong admin token, or an identity token that isn't valid
  forbidden: 403, //               an admin endpoint, and a signed-in person who doesn't hold core.admin
  missing_signature: 401, //      registration without the x-asafarim-* headers
  bad_signature: 401, //          signature doesn't verify with the app's credential
  expired_signature: 401, //      timestamp outside ±60 s
  replayed_signature: 401, //     nonce already used
  unknown_app: 403, //            no install record (or removed): can't register
  app_id_mismatch: 422, //        manifest.id ≠ the app id in the URL
  invalid_manifest: 422, //       fails @asafarim/app-manifest validation
  namespace_violation: 422, //    declares something outside <id>.*
  already_installed: 409, //      install of an app that's already installed
  invalid_state: 409, //          a lifecycle change that isn't allowed from the current state
  not_found: 404,
  role_not_found: 404, //         grant/revoke names a role that doesn't exist or is deprecated
  bad_request: 400,
  app_inactive: 503, //           a token is only issued for an active app
  bus_unavailable: 503, //        install of an app that publishes events, and its stream couldn't be created (P4.1)
} as const;

export type ErrorCode = keyof typeof ERRORS;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "ApiError";
    this.code = code;
    this.status = ERRORS[code];
    this.details = details;
  }
}
