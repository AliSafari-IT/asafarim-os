/**
 * The app's single connection to the platform: self-registration on boot and permission checks
 * (@asafarim/app-sdk). One instance per server process.
 */
import { startApp, type Platform } from "@asafarim/app-sdk";
import manifest from "../platform.app";

const globalForPlatform = globalThis as unknown as { docsPlatform?: Platform };

export function getPlatform(): Platform {
  globalForPlatform.docsPlatform ??= startApp({ manifest });
  return globalForPlatform.docsPlatform;
}

export { manifest };
