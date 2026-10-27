/**
 * docs: a private reader for documentation repositories (#76). The owner reads the Markdown of a
 * docs repo, keeps study notes on parts of it, and turns a note into a GitHub issue. The code is
 * public and generic: which repository it reads is configuration, and documents are only ever
 * fetched at runtime, never built into the image.
 * Schema: @asafarim/app-manifest.
 */
import { defineApp } from "@asafarim/app-manifest";

export default defineApp({
  id: "docs",
  name: "Docs",
  version: "0.1.0",
  platform: ">=0.1 <1",
  owner: "ASafariM Digital",
  domains: {
    primary: "docs.asafarim.site",
  },
  runtime: {
    image: "docs",
    port: 3000,
    health: {
      live: "/api/health",
      ready: "/api/health",
    },
    // The VPS is shared.
    resources: {
      memory: "256m",
      cpus: 0.5,
    },
  },
  // Study notes live here.
  database: {
    engine: "postgres",
    migrations: "sql",
  },
  auth: {
    client: "oidc",
    publicPaths: ["/api/health"],
  },
  permissions: [
    { key: "docs.read", description: "Read the documents" },
    { key: "docs.notes.write", description: "Write study notes on a document" },
    {
      key: "docs.issues.create",
      description: "Turn a note into a GitHub issue in the repository that owns the document",
    },
  ],
  roles: [
    {
      key: "docs.owner",
      grants: ["docs.read", "docs.notes.write", "docs.issues.create"],
      description: "The owner of the documentation: reads, keeps notes and files issues",
    },
  ],
  // Flow (ADR 0001): published through the outbox in the same transaction as the note's write (lib/notes.ts),
  // or as the answer to Flow's request, in the request's inbox transaction (lib/issue-draft-handler.ts).
  events: {
    publishes: [
      { type: "docs.note.created.v1", schema: "./events/docs.note.created.v1.json" },
      { type: "docs.issue-draft.ready.v1", schema: "./events/docs.issue-draft.ready.v1.json" },
      { type: "docs.issue-draft.failed.v1", schema: "./events/docs.issue-draft.failed.v1.json" },
    ],
    subscribes: [{ type: "flow.issue-draft.requested.v1", handler: "/events/issue-draft-requested" }],
  },
  config: [
    {
      key: "source.repo",
      type: "string",
      default: "AliSafari-IT/asafarim-docs",
      description: "The GitHub repository (owner/name) whose Markdown the app shows",
    },
    { key: "source.branch", type: "string", default: "main", description: "The branch it reads" },
    {
      key: "ai.model",
      type: "string",
      default: "claude-sonnet-5-5",
      description: "The Claude model that drafts a GitHub issue from a note",
    },
  ],
  // Names only: values never appear in a manifest.
  secrets: ["DOCS_GITHUB_TOKEN", "DOCS_ISSUES_TOKEN", "DOCS_AI_API_KEY"],
  ui: {
    glyph: "DC",
    color: "#0f766e",
    nav: [{ label: "Docs", href: "/" }],
    status: "active",
    launcher: {
      description: "Read the documentation, keep study notes and turn them into GitHub issues.",
      meta: "docs.asafarim.site",
      // Not public: the launcher only lists it for someone who holds docs.owner.
      access: "authenticated",
      order: 20,
    },
  },
});
