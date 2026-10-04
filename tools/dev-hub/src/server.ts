/**
 * tools/dev-hub: the LOCAL stand-in for Hub in the ASafariM OS sign-in
 * hand-off (OS-D1, #26). core/identity sends the browser here with a ticket;
 * you pick a seeded synthetic user; the stub posts a signed assertion back.
 * Refuses to start outside development (see guard.ts). Never shipped in an image.
 *
 *   GET  /oidc/continue?ticket=…      verify the ticket, list the seeded users
 *   POST /oidc/continue/select        re-verify, sign for the chosen user, auto-POST
 */
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { LISTEN_HOST, assertDevOnly } from "./guard.ts";
import { importEd25519, signAssertion, verifyTicket } from "./handoff.ts";
import { autoPostPage, chooseUserPage, errorPage, type SeedUser } from "./pages.ts";

export function loadSeedUsers(file = path.join(import.meta.dirname, "../seed-users.json")): SeedUser[] {
  return (JSON.parse(readFileSync(file, "utf8")) as { users: SeedUser[] }).users;
}

function send(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

export const MAX_FORM_BYTES = 16_384;

export class FormTooLargeError extends Error {}

/**
 * Read a small form body. Counts BYTES, keeps draining the request (breaking
 * out of the iterator would destroy the socket before we can answer) and
 * throws FormTooLargeError once the limit is crossed.
 */
export async function readForm(
  req: AsyncIterable<Buffer | string>,
  maxBytes = MAX_FORM_BYTES,
): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > maxBytes) tooLarge = true;
    else chunks.push(buf);
  }
  if (tooLarge) throw new FormTooLargeError();
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export async function createDevHub(env: Record<string, string | undefined> = process.env) {
  const issuer = assertDevOnly(env);
  const ticketKey = await importEd25519(env.DEV_HUB_TICKET_PUBLIC_JWK, "DEV_HUB_TICKET_PUBLIC_JWK", "public");
  const assertionKey = await importEd25519(
    env.DEV_HUB_ASSERTION_PRIVATE_JWK,
    "DEV_HUB_ASSERTION_PRIVATE_JWK",
    "private",
  );
  const users = loadSeedUsers();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/oidc/continue") {
        const ticket = url.searchParams.get("ticket") ?? "";
        await verifyTicket(ticket, ticketKey);
        return send(res, 200, chooseUserPage(ticket, users));
      }
      if (req.method === "POST" && url.pathname === "/oidc/continue/select") {
        const form = await readForm(req);
        const { uid } = await verifyTicket(form.get("ticket") ?? "", ticketKey);
        const sub = form.get("sub") ?? "";
        if (!users.some((u) => u.id === sub)) return send(res, 400, errorPage("Unknown dev user."));
        const assertion = await signAssertion(sub, uid, assertionKey);
        return send(res, 200, autoPostPage(`${issuer}/interaction/${encodeURIComponent(uid)}/hub`, assertion));
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"ok":true,"devOnly":true}');
      }
      send(res, 404, errorPage("Not found."));
    } catch (err) {
      if (err instanceof FormTooLargeError) return send(res, 413, errorPage("The request is too large."));
      send(res, 400, errorPage("The sign-in ticket is invalid or expired."));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const port = Number(process.env.DEV_HUB_PORT ?? 4000);
  createDevHub()
    .then((server) =>
      server.listen(port, LISTEN_HOST, () => console.log(`dev-hub (DEV ONLY login stub) on http://localhost:${port}`)),
    )
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
