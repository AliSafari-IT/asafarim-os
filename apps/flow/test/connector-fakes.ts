/**
 * What the connector tests run against: the real credential store and Settings on the in-memory tables
 * (memory-credentials.ts) plus `email_sends`; egress and SMTP stubbed at their boundary (the services'
 * `request` and `send`), with a fake GitHub behind egress. Every request egress was asked for is kept,
 * so a test can check nothing went out.
 */
import { keyringFromEnv } from "../lib/credentials/cipher";
import { createCredential } from "../lib/credentials/store";
import { EgressError, type EgressRequest, type EgressResponse } from "../lib/egress/egress";
import type { MailRequest } from "../lib/egress/smtp";
import { servicesFor, type ConnectorContext, type ConnectorServices } from "../lib/engine/connectors";
import type { Queryable } from "../lib/settings";
import { memoryCredentials } from "./memory-credentials";

export const KEY_ENV = { FLOW_CREDENTIALS_KEY: Buffer.alloc(32, 9).toString("base64") };
export const SMTP_PASSWORD = "smtp-PASSWORD-1f2e3d";
export const SMTP_USER = "smtp-USER-4c5b6a";
export const GITHUB_TOKEN = "ghp_SECRETTOKEN9a8b7c";

/** A fake GitHub: repositories with labels, issues and their comments; the token's user is `flow-bot`. */
export function fakeGithub() {
  interface Comment {
    id: number;
    body: string;
    user: { login: string };
    created: number;
  }
  interface Issue {
    number: number;
    title: string;
    body: string;
    labels: string[];
    state: string;
    stateReason?: string;
    creator: string;
    created: number;
    comments: Comment[];
    pull_request?: object;
  }
  const repos = new Map<string, { labels: string[]; issues: Issue[] }>();
  let nextId = 1000;
  let clock = Date.parse("2026-10-28T10:00:00Z");
  /** What the next calls answer instead (a status, or an egress error), in order. */
  const script: ({ status: number; headers?: Record<string, string> } | EgressError)[] = [];
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const json = (status: number, value: unknown, headers: Record<string, string> = {}): EgressResponse => ({
    status,
    headers,
    body: Buffer.from(JSON.stringify(value)),
  });
  const page = <T>(items: T[], q: URLSearchParams) => {
    const per = Number(q.get("per_page") ?? 30);
    const n = Number(q.get("page") ?? 1);
    return items.slice((n - 1) * per, n * per);
  };
  const issueJson = (repo: string, i: Issue) => ({
    number: i.number,
    html_url: `https://github.com/${repo}/issues/${i.number}`,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    ...(i.pull_request ? { pull_request: i.pull_request } : {}),
  });

  function handle(req: EgressRequest): EgressResponse {
    const url = new URL(req.url);
    const body = req.body === undefined ? undefined : JSON.parse(String(req.body));
    calls.push({ method: req.method, path: url.pathname, ...(body === undefined ? {} : { body }) });
    const next = script.shift();
    if (next instanceof EgressError) throw next;
    if (next) return json(next.status, { message: "scripted" }, next.headers);
    if (req.headers?.Authorization !== `Bearer ${GITHUB_TOKEN}`) return json(401, { message: "Bad credentials" });
    if (url.pathname === "/user" && req.method === "GET") return json(200, { login: "flow-bot" });
    const m = /^\/repos\/([^/]+\/[^/]+)\/(labels|issues)(?:\/(\d+)(?:\/(comments|labels))?)?$/.exec(url.pathname);
    const repo = m ? repos.get(m[1]!) : undefined;
    if (!m || !repo) return json(404, { message: "Not Found" });
    const [, name, what, num, sub] = m;
    const q = url.searchParams;
    if (what === "labels" && req.method === "GET")
      return json(
        200,
        page(
          repo.labels.map((l) => ({ name: l })),
          q,
        ),
      );
    if (what === "issues" && !num && req.method === "GET") {
      const since = Date.parse(q.get("since") ?? "1970-01-01");
      const list = repo.issues
        .filter((i) => (!q.get("creator") || i.creator === q.get("creator")) && i.created >= since)
        .sort((a, b) => b.created - a.created);
      return json(
        200,
        page(list, q).map((i) => issueJson(name!, i)),
      );
    }
    if (what === "issues" && !num && req.method === "POST") {
      if (!body.title) return json(422, { message: "Validation Failed" });
      const issue: Issue = {
        number: repo.issues.length + 1,
        title: body.title,
        body: body.body ?? "",
        labels: body.labels ?? [],
        state: "open",
        creator: "flow-bot",
        created: (clock += 1000),
        comments: [],
      };
      repo.issues.push(issue);
      return json(201, issueJson(name!, issue));
    }
    const issue = repo.issues.find((i) => i.number === Number(num));
    if (!issue) return json(404, { message: "Not Found" });
    if (sub === "comments" && req.method === "GET") {
      const since = Date.parse(q.get("since") ?? "1970-01-01");
      const list = issue.comments.filter((c) => c.created >= since);
      return json(
        200,
        page(list, q).map((c) => ({
          id: c.id,
          body: c.body,
          user: c.user,
          html_url: `https://github.com/${name}/issues/${issue.number}#issuecomment-${c.id}`,
        })),
      );
    }
    if (sub === "comments" && req.method === "POST") {
      const c = { id: nextId++, body: body.body, user: { login: "flow-bot" }, created: (clock += 1000) };
      issue.comments.push(c);
      return json(201, {
        id: c.id,
        html_url: `https://github.com/${name}/issues/${issue.number}#issuecomment-${c.id}`,
      });
    }
    if (sub === "labels" && req.method === "POST") {
      for (const l of body.labels as string[]) if (!issue.labels.includes(l)) issue.labels.push(l);
      return json(
        200,
        issue.labels.map((l) => ({ name: l })),
      );
    }
    if (!sub && req.method === "PATCH") {
      issue.state = body.state;
      issue.stateReason = body.state_reason;
      return json(200, issueJson(name!, issue));
    }
    return json(404, { message: "Not Found" });
  }

  return {
    repos,
    script,
    calls,
    handle,
    addRepo(name: string, labels: string[] = []) {
      repos.set(name, { labels, issues: [] });
    },
    issues: (name: string) => repos.get(name)!.issues,
    /** An issue (or comment) someone else wrote, at the fake's clock. */
    addIssue(name: string, issue: { title: string; body: string; creator: string; pullRequest?: boolean }) {
      repos.get(name)!.issues.push({
        number: repos.get(name)!.issues.length + 1,
        title: issue.title,
        body: issue.body,
        labels: [],
        state: "open",
        creator: issue.creator,
        created: (clock += 1000),
        comments: [],
        ...(issue.pullRequest ? { pull_request: {} } : {}),
      });
    },
    addComment(name: string, number: number, comment: { body: string; login: string }) {
      repos
        .get(name)!
        .issues.find((i) => i.number === number)!
        .comments.push({ id: nextId++, body: comment.body, user: { login: comment.login }, created: (clock += 1000) });
    },
  };
}

/** The tables and the stubbed boundaries one test works with. */
export async function fakeWorld(opts: { env?: Record<string, string | undefined> } = {}) {
  const mem = memoryCredentials();
  const sends: { step_id: string; run_id: string; workflow_id: string; created_at: Date }[] = [];
  const statements: string[] = [];
  const db = {
    async query(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      const sql = text.replace(/\s+/g, " ").trim();
      statements.push(sql);
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (sql.startsWith("SELECT 1 FROM email_sends WHERE step_id = $1"))
        return { rows: sends.filter((s) => s.step_id === values[0]).map(() => ({ "?column?": 1 })) };
      if (sql.startsWith("SELECT count(*) FILTER (WHERE workflow_id = $1)::int AS workflow")) {
        const day = sends.filter((s) => s.created_at.getTime() > Date.now() - 24 * 60 * 60 * 1000);
        return { rows: [{ workflow: day.filter((s) => s.workflow_id === values[0]).length, total: day.length }] };
      }
      if (sql.startsWith("INSERT INTO email_sends")) {
        sends.push({
          step_id: values[0] as string,
          run_id: values[1] as string,
          workflow_id: values[2] as string,
          created_at: new Date(),
        });
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM email_sends WHERE step_id = $1")) {
        const i = sends.findIndex((s) => s.step_id === values[0]);
        if (i >= 0) sends.splice(i, 1);
        return { rows: [] };
      }
      return mem.db.query(text, values);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  const env = opts.env ?? KEY_ENV;
  const keyring = () => {
    const k = keyringFromEnv(env);
    return k.ok ? k.keyring : undefined;
  };
  const github = fakeGithub();
  /** Every request egress was asked for; `onRequest` answers (default: the fake GitHub). */
  const requests: EgressRequest[] = [];
  const mails: MailRequest[] = [];
  const world = {
    mem,
    db,
    sends,
    statements,
    github,
    requests,
    mails,
    onRequest: (req: EgressRequest): EgressResponse | Promise<EgressResponse> => github.handle(req),
    onMail: async (_req: MailRequest): Promise<{ messageId?: string }> => ({ messageId: "queued-1" }),
    services: undefined as unknown as ConnectorServices,
  };
  world.services = {
    db: async () => db as never,
    egress: {
      request: async (_q, req) => {
        requests.push(req);
        return world.onRequest(req);
      },
    },
    smtp: {
      send: async (_q, req) => {
        mails.push(req);
        return world.onMail(req);
      },
    },
    keyring,
  };
  const k = keyringFromEnv(KEY_ENV);
  const keys = k.ok ? k.keyring : undefined;
  const credential = async (input: unknown) => {
    const r = await createCredential(db, input, "dev-owner", keys);
    if (!r.ok) throw new Error(r.error);
    return { id: r.id, shownOnce: r.shownOnce };
  };
  const smtp = await credential({
    kind: "smtp",
    name: "mail",
    meta: { host: "smtp.example.com", port: "587", mode: "starttls", from: "flow@example.com" },
    secret: { username: SMTP_USER, password: SMTP_PASSWORD },
  });
  const gh = await credential({
    kind: "github-token",
    name: "github",
    meta: { repos: ["acme/widgets", "acme/gadgets"] },
    secret: { token: GITHUB_TOKEN },
  });
  const hook = await credential({ kind: "webhook-secret", name: "hook" });
  github.addRepo("acme/widgets", ["bug", "Needs Triage"]);
  github.addRepo("acme/gadgets");
  github.addRepo("acme/other");
  // The same object the services read `onRequest` and `onMail` from: a test may replace them.
  return Object.assign(world, {
    ids: { smtp: smtp.id, github: gh.id, webhook: hook.id },
    webhookSecret: hook.shownOnce!,
  });
}

export type World = Awaited<ReturnType<typeof fakeWorld>>;

/** A connector's context for one call of step `stepKey` in run `runId`; its log lines are kept. */
export function contextFor(
  world: World,
  opts: { runId?: string; stepId?: string; stepKey?: string; workflowId?: string; connector?: string } = {},
) {
  const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
  const runId = opts.runId ?? "run-1";
  const stepId = opts.stepId ?? "step-1";
  const ctx: ConnectorContext = {
    runId,
    workflowId: opts.workflowId ?? "wf-1",
    runStartedAt: new Date("2026-10-28T09:59:00Z"),
    stepId,
    stepKey: opts.stepKey ?? "act",
    attempt: 1,
    test: false,
    log: {
      info: (msg, fields) => logs.push({ msg, fields }),
      warn: (msg, fields) => logs.push({ msg, fields }),
    },
    signal: new AbortController().signal,
    ...servicesFor(world.services, { connector: opts.connector ?? "test", runId, stepId }),
  };
  return { ctx, logs };
}
