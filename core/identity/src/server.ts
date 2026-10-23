/**
 * Entry point: `node src/server.ts` (Node 24 runs the TypeScript directly).
 */
import { createServer } from "node:http";
import { Redis } from "ioredis";
import { PgAccountStore, type AccountStore } from "./accounts.ts";
import { RedisAuthSessions, RedisEphemeral, RedisLoginFlows } from "./auth-session.ts";
import { ConfigError, loadConfig, type LocalLoginConfig } from "./config.ts";
import type { AppLink } from "./clients.ts";
import { createLogger, type Logger } from "./log.ts";
import { RedisOtpChallenges, RedisRateLimiter } from "./otp.ts";
import { setHomeUrl } from "./pages.ts";
import { createProvider, type ProviderDeps } from "./provider.ts";
import { RedisPendingLogins } from "./pending.ts";
import { RedisReplayGuard, endSessionsOfAccount, redisAdapterFactory } from "./redis-adapter.ts";
import { createSignIn } from "./sign-in.ts";
import { DevLogSmsSender, TwilioSmsSender } from "./sms.ts";
import { DevLogMailer, SmtpMailer } from "./smtp.ts";
import { PgIdentityStore, PrincipalAccounts } from "./store.ts";

const log = createLogger();

/** The local sign-in's pieces: its database (migrated, first admin bootstrapped) and its routes. */
async function localSignIn(config: LocalLoginConfig, issuer: string, apps: AppLink[], redis: Redis, logger: Logger) {
  const store = new PgIdentityStore(config.databaseUrl, (err) =>
    logger.warn("database.idle_error", { errorCode: (err as { code?: string }).code ?? err.name }),
  );
  const applied = await store.migrate();
  if (applied.length) logger.info("identity.migrated", { status: applied.join(",") });
  if (config.bootstrapAdmin.length) {
    const outcome = await store.bootstrapAdmin(config.bootstrapAdmin);
    logger.info("identity.bootstrap_admin", { reason: outcome });
  }
  const issuerUrl = new URL(issuer);
  const signIn = createSignIn({
    issuer,
    homeUrl: config.homeUrl,
    ...(config.adminConsoleUrl ? { adminConsoleUrl: config.adminConsoleUrl } : {}),
    apps,
    otpSecret: config.otpSecret,
    ...(config.email
      ? {
          email: {
            mailer:
              config.email.mailer.kind === "smtp"
                ? new SmtpMailer({ ...config.email.mailer.smtp, heloName: issuerUrl.hostname })
                : new DevLogMailer(),
            dailyLimit: config.email.dailyLimit,
          },
        }
      : {}),
    ...(config.sms
      ? {
          sms: {
            sender:
              config.sms.sender.provider === "twilio"
                ? new TwilioSmsSender(config.sms.sender.twilio)
                : new DevLogSmsSender(),
            allowedPrefixes: config.sms.allowedPrefixes,
            dailyLimit: config.sms.dailyLimit,
          },
        }
      : {}),
    ...(config.passkeys
      ? { passkeys: { rp: { id: issuerUrl.hostname, origin: issuerUrl.origin, name: "ASafariM" } } }
      : {}),
    ephemeral: new RedisEphemeral(redis),
    store,
    challenges: new RedisOtpChallenges(redis),
    limits: new RedisRateLimiter(redis),
    sessions: new RedisAuthSessions(redis),
    flows: new RedisLoginFlows(redis),
    endProviderSessions: (principalId) => endSessionsOfAccount(redis, principalId),
    log: logger,
  });
  return { store, signIn };
}

async function main() {
  const config = await loadConfig();
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true });
  redis.on("error", (err) => log.error("redis.error", { errorCode: (err as { code?: string }).code ?? err.name }));

  let accounts: AccountStore;
  let closeDatabase: () => Promise<void>;
  let method: Pick<
    ProviderDeps,
    "loginMethod" | "handoffPrivateKey" | "hubPublicKey" | "hubContinueUrl" | "replay" | "pending" | "signIn"
  >;
  if (config.login.method === "local") {
    setHomeUrl(config.login.homeUrl);
    const { store, signIn } = await localSignIn(config.login, config.issuer, config.apps, redis, log);
    accounts = new PrincipalAccounts(store);
    closeDatabase = () => store.close();
    method = { loginMethod: "local", signIn };
  } else {
    const platform = new PgAccountStore(config.login.accountsDatabaseUrl);
    accounts = platform;
    closeDatabase = () => platform.close();
    method = {
      loginMethod: "hub",
      handoffPrivateKey: config.login.handoffPrivateKey,
      hubPublicKey: config.login.hubPublicKey,
      hubContinueUrl: config.login.hubContinueUrl,
      replay: new RedisReplayGuard(redis),
      pending: new RedisPendingLogins(redis),
    };
  }

  const provider = createProvider({
    issuer: config.issuer,
    jwks: config.jwks,
    cookieKeys: config.cookieKeys,
    clients: config.clients,
    trustProxy: config.trustProxy,
    ...method,
    adapter: redisAdapterFactory(redis),
    accounts,
    log,
    readiness: async () => {
      const [r, d] = await Promise.allSettled([redis.ping(), accounts.ping()]);
      return { redis: r.status === "fulfilled", database: d.status === "fulfilled" };
    },
  });

  const server = createServer(provider.callback());
  server.listen(config.port, () =>
    log.info("identity.started", { port: config.port, clients: config.clients.length, reason: config.login.method }),
  );

  const shutdown = (signal: string) => {
    log.info("identity.shutdown", { reason: signal });
    server.close(() => {
      void Promise.allSettled([redis.quit(), closeDatabase()]).then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  // Config errors name the variable, never its value.
  log.error("identity.start_failed", { errorCode: err instanceof ConfigError ? err.message : (err as Error).name });
  process.exit(1);
});
