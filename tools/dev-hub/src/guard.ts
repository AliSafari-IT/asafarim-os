/**
 * The dev login stub signs sign-in assertions for ANY seeded user without a
 * password. It must never run anywhere but a developer's machine (OS-D1, #26):
 * it starts only with NODE_ENV=development AND an identity issuer on
 * localhost, and it only listens on 127.0.0.1.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class DevOnlyError extends Error {
  constructor(reason: string) {
    super(`tools/dev-hub is a development-only login stub and refuses to start: ${reason}`);
    this.name = "DevOnlyError";
  }
}

/** Throws unless this is clearly local development. Returns the issuer origin. */
export function assertDevOnly(env: Record<string, string | undefined>): string {
  if (env.NODE_ENV !== "development") throw new DevOnlyError(`NODE_ENV is "${env.NODE_ENV ?? ""}", not "development"`);
  const raw = env.DEV_HUB_IDENTITY_ISSUER;
  if (!raw) throw new DevOnlyError("DEV_HUB_IDENTITY_ISSUER is not set");
  let issuer: URL;
  try {
    issuer = new URL(raw);
  } catch {
    throw new DevOnlyError("DEV_HUB_IDENTITY_ISSUER is not a URL");
  }
  if (!LOCAL_HOSTS.has(issuer.hostname)) {
    throw new DevOnlyError(`the identity issuer ${issuer.hostname} is not localhost`);
  }
  return issuer.origin;
}

/** The only interface the stub binds to. */
export const LISTEN_HOST = "127.0.0.1";
