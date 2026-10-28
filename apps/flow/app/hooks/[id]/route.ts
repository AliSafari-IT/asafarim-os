/**
 * POST /hooks/<id>: webhook in (lib/hooks/receive.ts). Public in the manifest (`auth.publicPaths`, no
 * route permission), so the gateway lets it through without sign-in: the hook's signature is what
 * authenticates a call.
 */
import { db, engine, inTransaction } from "@/lib/db";
import { createRateLimiter } from "@/lib/hooks/limiter";
import { receiveHook, type ReceiveDeps } from "@/lib/hooks/receive";
import { findHook, touchHook } from "@/lib/hooks/store";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const globalForHooks = globalThis as unknown as { flowHookLimiter?: ReturnType<typeof createRateLimiter> };

const deps: ReceiveDeps = {
  findHook: async (id) => findHook(await db(), id),
  start: async (hook, opts) =>
    inTransaction(await db(), async (tx) => {
      await touchHook(tx, hook.id);
      return engine.startRun(tx, opts);
    }),
  touch: async (hook) => touchHook(await db(), hook.id),
  limiter: (globalForHooks.flowHookLimiter ??= createRateLimiter()),
  now: () => new Date(),
  log,
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return receiveHook(request, (await params).id, deps);
}
