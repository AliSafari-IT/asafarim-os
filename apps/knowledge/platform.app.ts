/**
 * knowledge: ASafariM Knowledge, technical publishing and learning on ASafariM OS (#354, Phase 0).
 * Authors write articles in the studio; anyone may read what has been published. Design:
 * asafarim-docs ventures/asafarim-os/specs/ai-publishing-learning-platform.md.
 * Schema: @asafarim/app-manifest.
 */
import { defineApp } from "@asafarim/app-manifest";

export default defineApp({
  id: "knowledge",
  name: "ASafariM Knowledge",
  version: "0.1.5",
  platform: ">=0.1 <1",
  owner: "ASafariM Digital",
  // Proposed, not allocated: only the dev gateway is generated from this. No production route yet.
  domains: {
    primary: "learn.asafarim.site",
  },
  runtime: {
    image: "knowledge",
    port: 3000,
    health: {
      live: "/health/live",
      ready: "/health/ready",
    },
    resources: {
      memory: "256m",
      cpus: 0.5,
    },
  },
  // Articles and their immutable revisions (lib/migrations.ts).
  database: {
    engine: "postgres",
    migrations: "sql",
  },
  auth: {
    client: "oidc",
    // Published articles are for everyone. The app only ever reads published revisions there.
    publicPaths: ["/", "/articles/**", "/health/live", "/health/ready"],
  },
  permissions: [
    { key: "knowledge.content.create", description: "Open the studio and create article drafts" },
    { key: "knowledge.content.edit.own", description: "Edit and save drafts of your own articles" },
    { key: "knowledge.content.edit.any", description: "Edit and save drafts of any article" },
    { key: "knowledge.content.publish.own", description: "Publish and withdraw your own articles" },
    { key: "knowledge.content.publish.any", description: "Publish and withdraw any article" },
    {
      key: "knowledge.ai.use",
      description: "Ask the AI for proposals (outline, rewrite, summary, diagram) on articles you may edit",
    },
  ],
  roles: [
    {
      key: "knowledge.author",
      grants: [
        "knowledge.content.create",
        "knowledge.content.edit.own",
        "knowledge.content.publish.own",
        "knowledge.ai.use",
      ],
      description: "Writes, publishes and withdraws their own articles",
    },
    {
      key: "knowledge.editor",
      grants: [
        "knowledge.content.create",
        "knowledge.content.edit.own",
        "knowledge.content.edit.any",
        "knowledge.content.publish.own",
        "knowledge.content.publish.any",
        "knowledge.ai.use",
      ],
      description: "Edits, publishes and withdraws any article",
    },
  ],
  routes: [
    // Studio PAGES are for authors: the gateway asks for the permission before the app renders one, and
    // an expired access token is renewed by redirecting through /api/asafarim/session. Only GET/HEAD:
    // the studio's server actions are POSTs, and for a POST the gateway can only answer 401 once the
    // 60 s token has expired, which would lose a save (#363). The app authorises every action itself
    // (lib/studio.ts: signed in, app active, the permission from core-api, then ownership per article),
    // as Flow and Docs do for all their pages and actions.
    { path: "/studio/**", methods: ["GET", "HEAD"], permission: "knowledge.content.create" },
  ],
  // Names only: values never appear in a manifest. Optional: without it the AI assistance is off (#360).
  secrets: ["KNOWLEDGE_AI_API_KEY"],
  ui: {
    glyph: "KN",
    color: "#0e7490",
    nav: [
      { label: "Articles", href: "/" },
      { label: "Studio", href: "/studio" },
    ],
    status: "active",
    // No launcher tile until the app is deployed at its own address (a later issue).
  },
});
