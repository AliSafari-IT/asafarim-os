/**
 * Entry point: `node src/server.ts` (Node 24 runs the TypeScript directly).
 */
import { createServer } from "node:http";
import { Redis } from "ioredis";
import { PgAccountStore } from "./accounts.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { createProvider } from "./provider.ts";
import { RedisReplayGuard, redisAdapterFactory } from "./redis-adapter.ts";

const log = createLogger();

async function main() {
  const config = await loadConfig();
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true });
  redis.on("error", (err) => log.error("redis.error", { errorCode: (err as { code?: string }).code ?? err.name }));
  const accounts = new PgAccountStore(config.accountsDatabaseUrl);

  const provider = createProvider({
    ...config,
    adapter: redisAdapterFactory(redis),
    accounts,
    replay: new RedisReplayGuard(redis),
    log,
    readiness: async () => {
      const [r, d] = await Promise.allSettled([redis.ping(), accounts.ping()]);
      return { redis: r.status === "fulfilled", database: d.status === "fulfilled" };
    },
  });

  const server = createServer(provider.callback());
  server.listen(config.port, () => log.info("identity.started", { port: config.port, clients: config.clients.length }));

  const shutdown = (signal: string) => {
    log.info("identity.shutdown", { reason: signal });
    server.close(() => {
      void Promise.allSettled([redis.quit(), accounts.close()]).then(() => process.exit(0));
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
