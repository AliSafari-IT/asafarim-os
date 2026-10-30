/**
 * flow: ASafariM Flow (ADR 0001), workflows across OS apps through events only. It subscribes to an
 * app's fact events (triggers), publishes request events under `flow.*`, and waits for the acting
 * app's outcome events; it never calls another app's API or reads its database.
 * Schema: @asafarim/app-manifest.
 */
import { defineApp } from "@asafarim/app-manifest";

export default defineApp({
  id: "flow",
  name: "Flow",
  version: "0.1.0",
  platform: ">=0.1 <1",
  owner: "ASafariM Digital",
  domains: {
    primary: "flow.asafarim.site",
  },
  runtime: {
    image: "flow",
    port: 3000,
    health: {
      live: "/health/live",
      ready: "/health/ready",
    },
    // The VPS is shared.
    resources: {
      memory: "192m",
      cpus: 0.5,
    },
  },
  // Workflows, their versions, runs and steps live here (lib/migrations.ts).
  database: {
    engine: "postgres",
    migrations: "sql",
  },
  auth: {
    client: "oidc",
    // /hooks/<id>: webhook in, signed with the hook's secret instead of a sign-in (lib/hooks/receive.ts).
    publicPaths: ["/health/live", "/health/ready", "/hooks/*"],
  },
  permissions: [
    { key: "flow.read", description: "See workflows and their runs" },
    { key: "flow.workflows.write", description: "Pause and resume workflows" },
    { key: "flow.runs.start", description: "Retry or cancel a run" },
    { key: "flow.approvals.decide", description: "Approve or reject a step that waits for a person" },
    { key: "flow.credentials.write", description: "Add, rotate and delete the credentials connectors use" },
    { key: "flow.settings.write", description: "Edit the egress and email allow-lists, pause and resume all of Flow" },
    {
      key: "flow.workflows.generate",
      description:
        "Generate a workflow draft from a GitHub or GitLab issue with AI (sends the issue to an outside AI provider)",
    },
  ],
  roles: [
    { key: "flow.viewer", grants: ["flow.read"], description: "Can see workflows and runs" },
    {
      key: "flow.approver",
      grants: ["flow.read", "flow.approvals.decide"],
      description: "Can see runs and decide their approvals",
    },
    {
      key: "flow.owner",
      grants: [
        "flow.read",
        "flow.workflows.write",
        "flow.runs.start",
        "flow.approvals.decide",
        "flow.credentials.write",
        "flow.settings.write",
        "flow.workflows.generate",
      ],
      description: "Runs Flow: workflows, runs, approvals, credentials and settings",
    },
  ],
  routes: [
    // Nothing is served here; the subscriptions' handler paths are named under it, never exposed.
    { path: "/internal/**", expose: false },
  ],
  events: {
    // Written to the outbox in the same transaction as the step that sends them (lib/engine/).
    publishes: [
      { type: "flow.issue-draft.requested.v1", schema: "./events/flow.issue-draft.requested.v1.json" },
      { type: "flow.issue.approved.v1", schema: "./events/flow.issue.approved.v1.json" },
    ],
    // Consumed by lib/engine/subscribers.ts, inbox and transition in one transaction. Docs publishes
    // the trigger and the draft outcomes; the issue outcomes have no publisher yet (core-api reports
    // waiting_for_publisher until Flow PR 5).
    subscribes: [
      { type: "docs.note.created.v1", handler: "/internal/events/docs.note.created.v1" },
      { type: "docs.issue-draft.ready.v1", handler: "/internal/events/docs.issue-draft.ready.v1" },
      { type: "docs.issue-draft.failed.v1", handler: "/internal/events/docs.issue-draft.failed.v1" },
      { type: "docs.issue.created.v1", handler: "/internal/events/docs.issue.created.v1" },
      { type: "docs.issue.failed.v1", handler: "/internal/events/docs.issue.failed.v1" },
    ],
  },
  config: [
    {
      key: "docs.url",
      type: "string",
      default: "https://docs.asafarim.site",
      description: "Where Docs is served: the approval page links the draft's document there",
    },
  ],
  ui: {
    glyph: "FL",
    color: "#2563eb",
    nav: [
      { label: "Overview", href: "/" },
      { label: "Runs", href: "/runs" },
      { label: "Approvals", href: "/approvals" },
      { label: "Workflows", href: "/workflows" },
      { label: "Credentials", href: "/credentials" },
      { label: "Settings", href: "/settings" },
    ],
    status: "active",
    launcher: {
      description: "Workflows across your apps: a #issue note in Docs becomes a GitHub issue once you approve it.",
      meta: "flow.asafarim.site",
      // Not public: the launcher only lists it for someone who holds a flow.* role.
      access: "authenticated",
      order: 30,
    },
  },
});
