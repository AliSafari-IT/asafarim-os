/**
 * @asafarim/app-sdk (P3.2): what an OS app needs from the platform.
 *
 *   const platform = startApp({ manifest });            // on boot (instrumentation.ts)
 *   await platform.access.require(session, "notes.write");  // throws ForbiddenError naming the permission
 *   platform.config.getInt("limits.maxNotes");           // typed, from the manifest
 *   NextAuth(asafarimAuthConfig({ issuer, clientId }));  // sign-in through core/identity
 */
import type { AppManifest } from "@asafarim/app-manifest";
import { createAccess, type Access } from "./access.ts";
import { createConfig, type AppConfig } from "./config.ts";
import { consoleLogger, registerApp, type RegisterResult, type SdkLogger } from "./register.ts";

export * from "./access.ts";
export * from "./auth.ts";
export * from "./config.ts";
export * from "./register.ts";
export * from "./token.ts";

export interface StartAppOptions {
  manifest: AppManifest;
  env?: Record<string, string | undefined>;
  log?: SdkLogger;
  fetch?: typeof fetch;
  /** Throw if registration fails (default: log and carry on, for local development). */
  strict?: boolean;
}

export interface Platform {
  appId: string;
  config: AppConfig;
  access: Access;
  /** Resolves when registration has finished (or given up); never rejects unless `strict`. */
  registered: Promise<RegisterResult>;
}

/** An access object for an app that isn't installed: everything is denied. */
function notInstalledAccess(): Access {
  const unavailable = async () => {
    throw new Error("the app isn't installed (ASAFARIM_REGISTRY_CREDENTIAL / CORE_API_URL are not set)");
  };
  return {
    access: unavailable,
    can: async () => false,
    require: unavailable,
    mintToken: unavailable,
    clearCache: () => undefined,
  } as Access;
}

/**
 * Read the app's platform env (ASAFARIM_APP_ID, ASAFARIM_REGISTRY_CREDENTIAL,
 * CORE_API_URL), start registering in the background and return the helpers.
 * Without credentials (not installed yet) it logs once and denies everything.
 */
export function startApp(opts: StartAppOptions): Platform {
  const env = opts.env ?? process.env;
  const log = opts.log ?? consoleLogger;
  const appId = env.ASAFARIM_APP_ID ?? opts.manifest.id;
  const credential = env.ASAFARIM_REGISTRY_CREDENTIAL;
  const coreApiUrl = env.CORE_API_URL;
  const config = createConfig(opts.manifest, env);

  if (!credential || !coreApiUrl) {
    log.warn("app.not_installed", { appId, hint: `pnpm platform app install ${appId}` });
    return {
      appId,
      config,
      access: notInstalledAccess(),
      registered: Promise.resolve({ ok: false, attempts: 0, error: "not_installed" }),
    };
  }

  const registered = registerApp({
    appId,
    credential,
    coreApiUrl,
    manifest: opts.manifest,
    strict: opts.strict,
    fetch: opts.fetch,
    log,
  });
  return {
    appId,
    config,
    // ASAFARIM_ACCESS_TTL_MS shortens the 60 s permission cache (development and tests).
    access: createAccess({
      appId,
      credential,
      coreApiUrl,
      fetch: opts.fetch,
      ttlMs: Number(env.ASAFARIM_ACCESS_TTL_MS) || undefined,
    }),
    registered,
  };
}
