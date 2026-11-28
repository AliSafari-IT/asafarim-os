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
  version: "0.7.2",
  platform: ">=0.1 <1",
  owner: "ASafariM Digital",
  // Live since #361. The dev gateway is generated from this; production routes it through
  // sites/asafarim-os-knowledge.caddy.
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
    // Search, topic pages and the search API read only the published projection (#357).
    // Published courses and their lessons too (#358): only published course revisions, only public articles.
    publicPaths: [
      "/",
      "/articles/**",
      "/courses",
      "/courses/**",
      "/search",
      "/topics/**",
      "/api/public/**",
      // The RSS feed of the newest published articles (app/feed.xml/route.ts).
      "/feed.xml",
      // Likes and comments on lessons (lib/engagement.ts): reading and liking are for everyone, guests included.
      // Writing a comment needs knowledge.comment.write, checked by the app on every request; not by a gateway route,
      // which would answer a comment POST with 401 once the 60 s access token expired (#363).
      "/api/engagement/**",
      // Uploaded media (#359): the app answers each request itself, public only while a public revision uses the
      // asset and otherwise only for a signed-in person who may see it (lib/media/assets.ts), 404 to anyone else.
      "/media/**",
      "/health/live",
      "/health/ready",
    ],
  },
  permissions: [
    { key: "knowledge.content.create", description: "Open the studio and create article drafts" },
    { key: "knowledge.content.edit.own", description: "Edit and save drafts of your own articles" },
    { key: "knowledge.content.edit.any", description: "Edit and save drafts of any article" },
    { key: "knowledge.content.publish.own", description: "Publish and withdraw your own articles" },
    { key: "knowledge.content.publish.any", description: "Publish and withdraw any article" },
    {
      key: "knowledge.taxonomy.manage",
      description: "Create topics and the curated tags (with aliases) authors classify articles with",
    },
    {
      key: "knowledge.courses.manage.own",
      description: "Create courses from published articles, and edit, publish and withdraw your own courses",
    },
    {
      key: "knowledge.courses.manage.any",
      description: "Edit, publish and withdraw any course",
    },
    {
      key: "knowledge.comment.write",
      description: "Write comments and replies on lessons, and edit or delete your own",
    },
    { key: "knowledge.comment.moderate", description: "Delete anyone's comments on lessons" },
    {
      key: "knowledge.ai.use",
      description:
        "Ask the AI for proposals (outline, rewrite, summary, diagram) on articles you may edit, and for assessment questions on courses you manage",
    },
  ],
  roles: [
    {
      key: "knowledge.author",
      grants: [
        "knowledge.content.create",
        "knowledge.content.edit.own",
        "knowledge.content.publish.own",
        "knowledge.courses.manage.own",
        "knowledge.ai.use",
        "knowledge.comment.write",
      ],
      description: "Writes, publishes and withdraws their own articles and courses",
    },
    {
      key: "knowledge.editor",
      grants: [
        "knowledge.content.create",
        "knowledge.content.edit.own",
        "knowledge.content.edit.any",
        "knowledge.content.publish.own",
        "knowledge.content.publish.any",
        "knowledge.taxonomy.manage",
        "knowledge.courses.manage.own",
        "knowledge.courses.manage.any",
        "knowledge.ai.use",
        "knowledge.comment.write",
        "knowledge.comment.moderate",
      ],
      description:
        "Edits, publishes and withdraws any article or course, curates topics and tags, and moderates comments",
    },
    {
      key: "knowledge.learner",
      grants: ["knowledge.comment.write"],
      description: "Comments on lessons (anyone may read them and like a lesson)",
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
  // Published through the outbox in the same transaction as the comment (lib/engagement.ts, lib/events.ts).
  events: {
    publishes: [{ type: "knowledge.comment.created.v2", schema: "./events/knowledge.comment.created.v2.json" }],
  },
  // Names only: values never appear in a manifest. Optional: without the first the AI assistance is off (#360);
  // without the media store's keys uploads are off (#359).
  // ENGAGEMENT_SALT keys guests' like hashes; without it likes and comments are off.
  secrets: ["KNOWLEDGE_AI_API_KEY", "KNOWLEDGE_MEDIA_ACCESS_KEY", "KNOWLEDGE_MEDIA_SECRET_KEY", "ENGAGEMENT_SALT"],
  ui: {
    glyph: "KN",
    color: "#0e7490",
    nav: [
      { label: "Articles", href: "/" },
      { label: "Courses", href: "/courses" },
      { label: "Studio", href: "/studio" },
    ],
    status: "active",
    launcher: {
      description: "Technical articles and learning from ASafariM: read what has been published, write in the studio.",
      meta: "learn.asafarim.site",
      // Public: published articles are for everyone, so every signed-in person sees the tile. The studio
      // still needs knowledge.author or knowledge.editor.
      access: "public",
      requiresAccountToUse: true,
      order: 40,
    },
  },
});
