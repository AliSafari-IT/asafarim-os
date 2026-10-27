/**
 * GitHub and Claude for slice 1's end-to-end test (`pnpm e2e`, Flow's suite): two small local HTTP
 * servers, in a process of their own, that Docs points at through DOCS_E2E_GITHUB_API_URL and DOCS_E2E_AI_API_URL (honoured only
 * on loopback). Nothing here reaches the internet, and no real token or key is used.
 *
 * GitHub: `example-org/demo-app` is public, every other repo private; each has the labels bug,
 * enhancement and docs; created issues are kept in memory and listed back (`creator`, `since`), as
 * Docs' crash recovery asks. `GET /__issues` returns every issue created, for the spec to count.
 * Claude: answers every Messages call with the `issue_draft` tool, its title naming the `e2e-…` marker
 * found in the note, so the spec can tell its runs apart.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const GITHUB_MOCK_PORT = 4191;
export const AI_MOCK_PORT = 4192;
const LOGIN = "docs-e2e-bot";
const LABELS = ["bug", "enhancement", "docs"];

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function github() {
  const issues = [];
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__issues") return send(res, 200, issues);
    if (url.pathname === "/user") return send(res, 200, { login: LOGIN });
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/labels|\/issues)?$/.exec(url.pathname);
    if (!m) return send(res, 404, { message: "Not Found" });
    const repo = `${m[1]}/${m[2]}`;
    const isPublic = repo === "example-org/demo-app";
    if (!m[3])
      return send(res, 200, { full_name: repo, private: !isPublic, visibility: isPublic ? "public" : "private" });
    if (m[3] === "/labels")
      return send(
        res,
        200,
        LABELS.map((name) => ({ name })),
      );
    if (req.method === "POST") {
      const input = await readJson(req);
      const number = issues.filter((i) => i.repo === repo).length + 1;
      const now = new Date().toISOString();
      const issue = {
        repo,
        number,
        html_url: `https://github.com/${repo}/issues/${number}`,
        title: input.title,
        body: input.body ?? "",
        labels: input.labels ?? [],
        user: { login: LOGIN },
        created_at: now,
        updated_at: now,
      };
      issues.push(issue);
      return send(res, 201, issue);
    }
    const since = url.searchParams.get("since");
    const creator = url.searchParams.get("creator");
    const page = Number(url.searchParams.get("page") ?? "1");
    const listed = issues
      .filter((i) => i.repo === repo)
      .filter((i) => !creator || i.user.login === creator)
      .filter((i) => !since || i.updated_at >= since)
      .reverse();
    return send(res, 200, page === 1 ? listed : []);
  });
}

function claude() {
  return createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) return send(res, 404, {});
    const body = await readJson(req);
    const text = JSON.stringify(body.messages ?? []);
    const marker = /e2e-[a-z0-9-]+/.exec(text)?.[0] ?? "e2e";
    send(res, 200, {
      id: "msg_e2e",
      type: "message",
      role: "assistant",
      model: body.model,
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_e2e",
          name: "issue_draft",
          input: {
            title: `Update the install step (${marker})`,
            body: [
              "## Context",
              "The guide's install step is out of date.",
              "## Problem / request",
              "Bring the step in line with the current setup.",
              "## Suggested steps",
              "1. Rewrite the step.",
              "## Done when",
              "- [ ] The step works as written.",
            ].join("\n"),
            // "made-up" isn't one of the repo's labels: the draft drops it.
            labels: ["docs", "made-up"],
          },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  });
}

export const GITHUB_MOCK_URL = `http://127.0.0.1:${GITHUB_MOCK_PORT}`;
export const AI_MOCK_URL = `http://127.0.0.1:${AI_MOCK_PORT}`;

// Run as its own process (`node apps/flow/e2e/mocks.mjs`): scripts/dev/e2e.mjs waits on each suite
// synchronously, so servers in its own process couldn't answer while a suite runs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  github().listen(GITHUB_MOCK_PORT, "127.0.0.1");
  claude().listen(AI_MOCK_PORT, "127.0.0.1");
}
