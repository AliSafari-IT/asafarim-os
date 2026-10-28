/**
 * Secrets are write-only. Known secrets go in through the Credentials page's server actions (add,
 * rotate, a refused add) and through egress (an Authorization header, a token in the query); then
 * the rendered Credentials list, every log and audit line written meanwhile, every error and every
 * action answer are searched for them. The only place a secret may appear is the answer to the add
 * (or rotate) that generated a webhook secret, once.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CredentialError } from "../lib/credentials/cipher";
import type { CredentialFormState } from "../lib/credentials/form";
import { memoryCredentials } from "./memory-credentials";

const mem = vi.hoisted(() => ({
  current: undefined as undefined | ReturnType<typeof memoryCredentials>,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("redirect"), { to });
  },
  forbidden: vi.fn(),
  unauthorized: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "dev-owner" } }), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/platform", () => ({
  getPlatform: () => ({
    access: {
      access: async () => ({ state: "active", roles: [], permissions: ["flow.credentials.write"] }),
      require: async () => undefined,
    },
  }),
}));
vi.mock("@/lib/db", async () => {
  const { writeAudit } = await import("../lib/audit");
  return {
    db: async () => mem.current!.db,
    engine: {},
    inTransaction: async (_p: unknown, fn: (tx: unknown) => Promise<{ audits: never[] }>) => {
      const r = await fn(mem.current!.db);
      writeAudit(r.audits);
      return r;
    },
  };
});

const SMTP_PASSWORD = "smtp-PASSWORD-7f3a9c";
const SMTP_USER = "smtp-USER-51be20";
const GITHUB_TOKEN = "ghp_TOKEN0b9e44d1";
const NEW_PASSWORD = "smtp-NEWPASS-c0ffee";
const NEW_TOKEN = "ghp_NEWTOKEN77aa01";
const REFUSED_PASSWORD = "smtp-REFUSED-9d9d9d";
const QUERY_SECRET = "query-SECRET-ab12cd";

const output: string[] = [];
const idle: CredentialFormState = { status: "idle" };

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

beforeAll(() => {
  mem.current = memoryCredentials();
  process.env.FLOW_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
  // Every log and audit line the app writes (lib/log.ts writes JSON lines to stdout and stderr).
  for (const stream of [process.stdout, process.stderr])
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof stream.write);
});

afterAll(() => {
  delete process.env.FLOW_CREDENTIALS_KEY;
  vi.restoreAllMocks();
});

describe("a known secret never comes back", () => {
  it("in the pages, the logs, the audit, the errors or the action answers", async () => {
    const actions = await import("../app/actions");
    const { CredentialTable } = await import("../components/Credentials");
    const { listCredentials, useCredential } = await import("../lib/credentials/store");
    const { createEgress, EgressError } = await import("../lib/egress/egress");
    const answers: unknown[] = [];
    const errors: unknown[] = [];

    const smtp = await actions.createCredentialAction(
      idle,
      form({
        kind: "smtp",
        name: "Mail",
        host: "smtp.example.com",
        port: "587",
        mode: "starttls",
        from: "flow@example.com",
        username: SMTP_USER,
        password: SMTP_PASSWORD,
      }),
    );
    const github = await actions.createCredentialAction(
      idle,
      form({ kind: "github-token", name: "GitHub", repos: "AliSafari-IT/asafarim-docs", token: GITHUB_TOKEN }),
    );
    const refused = await actions.createCredentialAction(
      idle,
      form({
        kind: "smtp",
        name: "Bad",
        host: "not a host",
        port: "587",
        mode: "starttls",
        from: "x@example.com",
        username: "u",
        password: REFUSED_PASSWORD,
      }),
    );
    const hook = await actions.createCredentialAction(idle, form({ kind: "webhook-secret", name: "Hook" }));
    answers.push(smtp, github, refused);
    expect(smtp).toEqual({ status: "done", kind: "smtp" });
    expect(github).toEqual({ status: "done", kind: "github-token" });
    expect(refused).toEqual({ status: "error", error: "invalid_credential" });
    expect(hook).toMatchObject({ status: "done", kind: "webhook-secret", secret: expect.any(String) });
    const webhookSecret = (hook as { secret: string }).secret;

    const [githubRow, hookRow, smtpRow] = [...mem.current!.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
    answers.push(
      await actions.rotateCredentialAction(
        idle,
        form({ credentialId: smtpRow!.id, kind: "smtp", username: SMTP_USER, password: NEW_PASSWORD }),
      ),
      await actions.rotateCredentialAction(
        idle,
        form({ credentialId: githubRow!.id, kind: "github-token", token: NEW_TOKEN }),
      ),
    );
    const rotatedHook = await actions.rotateCredentialAction(
      idle,
      form({ credentialId: hookRow!.id, kind: "webhook-secret" }),
    );
    const newWebhookSecret = (rotatedHook as { secret: string }).secret;
    expect(newWebhookSecret).toMatch(/^[\w-]{43}$/);

    // A connector uses them: the secret is what it gets, and nothing else sees it.
    expect((await useCredential(mem.current!.db, githubRow!.id, "github-token")).token).toBe(NEW_TOKEN);
    try {
      await useCredential(mem.current!.db, githubRow!.id, "smtp");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialError);
      errors.push(err);
    }

    // Egress with the token in a header and in the query: refused calls, and a failed one.
    const egress = createEgress({ resolve: async () => [{ address: "10.0.0.1", family: 4 }] });
    const egressDb = {
      async query(text: string, values: unknown[] = []) {
        // Settings (not paused) and the connector_calls rows, which are searched with the answers.
        if (!text.startsWith("SELECT value FROM settings")) answers.push(values);
        return { rows: [] };
      },
    };
    for (const url of [
      `https://api.github.com/repos?token=${QUERY_SECRET}`,
      `https://user:${SMTP_PASSWORD}@api.github.com/x`,
      `http://api.github.com/x?t=${QUERY_SECRET}`,
    ]) {
      try {
        await egress.request(egressDb, {
          method: "POST",
          url,
          headers: { authorization: `Bearer ${NEW_TOKEN}` },
          body: JSON.stringify({ token: NEW_TOKEN }),
          allow: [{ host: "api.github.com" }],
          call: { connector: "github", runId: "r", stepId: "s" },
        });
      } catch (err) {
        expect(err).toBeInstanceOf(EgressError);
        errors.push(err);
      }
    }
    expect(errors).toHaveLength(4);

    const html = renderToStaticMarkup(
      createElement(CredentialTable, { credentials: await listCredentials(mem.current!.db), canUse: true }),
    );
    expect(html).toContain("Mail");
    expect(html).toContain("smtp.example.com");

    const haystacks = {
      html,
      logs: output.join(""),
      errors: errors.map((e) => `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ""}`).join("\n"),
      answers: JSON.stringify(answers),
    };
    expect(haystacks.logs).toContain("flow.credential.created");
    expect(haystacks.logs).toContain("egress.call");
    const secrets = [
      SMTP_PASSWORD,
      SMTP_USER,
      GITHUB_TOKEN,
      NEW_PASSWORD,
      NEW_TOKEN,
      REFUSED_PASSWORD,
      QUERY_SECRET,
      webhookSecret,
      newWebhookSecret,
    ];
    for (const [where, text] of Object.entries(haystacks))
      for (const secret of secrets) expect({ where, found: text.includes(secret) }).toEqual({ where, found: false });
  });
});
