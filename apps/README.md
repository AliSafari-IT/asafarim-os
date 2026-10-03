# apps/

Built-in apps. Each app is a self-describing plugin in `apps/<id>/`, with:

- a manifest (`platform.app.ts`, compiled to `platform.app.json`);
- its own database and migrations;
- its own image.

Apps depend only on the platform SDK and the shared presets in `packages/`, never on another app.

`pnpm platform:sync` discovers every `apps/<id>/platform.app.json`. Empty for now.
