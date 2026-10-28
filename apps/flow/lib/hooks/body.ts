/** A request body read with a byte cap: the stream is cancelled at the first chunk past it. */

/** The largest body a hook takes. */
export const BODY_MAX_BYTES = 256 * 1024;

/** The body's bytes, or undefined once it is over `cap` (what is left of the stream is never read). */
export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap = BODY_MAX_BYTES,
): Promise<Uint8Array | undefined> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
