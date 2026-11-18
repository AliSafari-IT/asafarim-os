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
  version: "0.1.0",
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
  ],
  roles: [
    {
      key: "knowledge.author",
      grants: ["knowledge.content.create", "knowledge.content.edit.own", "knowledge.content.publish.own"],
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
      ],
      description: "Edits, publishes and withdraws any article",
    },
  ],
  routes: [
    // The studio (pages and their server actions) is for authors: the gateway asks for the permission
    // before the app sees the request, and the app checks it again with ownership per article.
    { path: "/studio/**", permission: "knowledge.content.create" },
  ],
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
