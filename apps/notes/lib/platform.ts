/**
 * The app's single connection to the platform: self-registration on boot and
 * permission checks (@asafarim/app-sdk). One instance per server process.
 */
import { startApp, type Platform } from "@asafarim/app-sdk";
import manifest from "../platform.app";

const globalForPlatform = globalThis as unknown as { notesPlatform?: Platform };

export function getPlatform(): Platform {
  globalForPlatform.notesPlatform ??= startApp({ manifest });
  return globalForPlatform.notesPlatform;
}

export { manifest };
