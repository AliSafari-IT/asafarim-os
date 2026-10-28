/** What a connector throws when its call fails (lib/engine/connectors.ts). Its own module: the built-in
 * connectors (lib/connectors) import it, and the registry imports them. */
export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}
