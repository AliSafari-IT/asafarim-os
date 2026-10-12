/** The app's JSON logger: inside a request each line carries the trace id (P6.2). */
import { createLogger } from "@asafarim/telemetry";

export const log = createLogger({ app: "notes" });
