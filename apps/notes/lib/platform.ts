/**
 * The app's single connection to the platform: self-registration on boot (then the upload of its
 * event schemas for the Admin catalog) and permission checks (@asafarim/app-sdk). One instance per
 * server process.
 */
import { startApp, type Platform } from "@asafarim/app-sdk";
import manifest from "../platform.app";
import { EVENT_SCHEMAS } from "./schemas";

const globalForPlatform = globalThis as unknown as { notesPlatform?: Platform };

export function getPlatform(): Platform {
  globalForPlatform.notesPlatform ??= startApp({ manifest, schemas: EVENT_SCHEMAS });
  return globalForPlatform.notesPlatform;
}

export { manifest };
