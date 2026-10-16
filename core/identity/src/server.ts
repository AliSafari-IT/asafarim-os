/**
 * Entry point: `node src/server.ts` (Node 24 runs the TypeScript directly).
 */
import { createServer } from "node:http";
import { Redis } from "ioredis";
import { PgAccountStore, type AccountStore } from "./accounts.ts";
import { RedisAuthSessions, RedisLoginFlows } from "./auth-session.ts";
import { ConfigError, loadConfig, type SmsLoginConfig } from "./config.ts";
import { createLogger, type Logger } from "./log.ts";
import { RedisOtpChallenges, RedisRateLimiter } from "./otp.ts";
import { createProvider, type ProviderDeps } from "./provider.ts";
import { RedisPendingLogins } from "./pending.ts";
import { RedisReplayGuard, endSessionsOfAccount, redisAdapterFactory } from "./redis-adapter.ts";
import { DevLogSmsSender, TwilioSmsSender } from "./sms.ts";
import { createSmsLogin } from "./sms-login.ts";
import { PgIdentityStore, PrincipalAccounts } from "./store.ts";

const log = createLogger();

/** The SMS method's pieces: its database (migrated, first admin bootstrapped) and its sign-in. */
async function smsLogin(config: SmsLoginConfig, issuer: string, redis: Redis, logger: Logger) {
  const store = new PgIdentityStore(config.databaseUrl, (err) =>
    logger.warn("database.idle_error", { errorCode: (err as { code?: string }).code ?? err.name }),
  );
  const applied = await store.migrate();
  if (applied.length) logger.info("identity.migrated", { status: applied.join(",") });
  if (config.bootstrapAdminPhone) {
    const outcome = await store.bootstrapAdmin(config.bootstrapAdminPhone);
    logger.info("identity.bootstrap_admin", { reason: outcome });
  }
  const sender =
    config.sender.provider === "twilio" ? new TwilioSmsSender(config.sender.twilio) : new DevLogSmsSender();
  const sms = createSmsLogin({
    issuer,
    homeUrl: config.homeUrl,
    otpSecret: config.otpSecret,
    allowedPrefixes: config.allowedPrefixes,
    dailySmsLimit: config.dailySmsLimit,
    store,
    challenges: new RedisOtpChallenges(redis),
    limits: new RedisRateLimiter(redis),
    sessions: new RedisAuthSessions(redis),
    flows: new RedisLoginFlows(redis),
    sender,
    endProviderSessions: (principalId) => endSessionsOfAccount(redis, principalId),
    log: logger,
  });
  return { store, sms };
}

async function main() {
  const config = await loadConfig();
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true });
  redis.on("error", (err) => log.error("redis.error", { errorCode: (err as { code?: string }).code ?? err.name }));

  let accounts: AccountStore;
  let closeDatabase: () => Promise<void>;
  let method: Pick<
    ProviderDeps,
    "loginMethod" | "handoffPrivateKey" | "hubPublicKey" | "hubContinueUrl" | "replay" | "pending" | "sms"
  >;
  if (config.login.method === "sms") {
    const { store, sms } = await smsLogin(config.login, config.issuer, redis, log);
    accounts = new PrincipalAccounts(store);
    closeDatabase = () => store.close();
    method = { loginMethod: "sms", sms };
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
