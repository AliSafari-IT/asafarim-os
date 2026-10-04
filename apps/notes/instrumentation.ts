/** Runs once when the server starts: register with core-api (signed, retried, non-fatal). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getPlatform } = await import("./lib/platform");
  getPlatform();
}
