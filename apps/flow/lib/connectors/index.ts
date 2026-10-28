/** The connectors Flow ships, registered in the process's registry (lib/engine/connectors.ts). */
import type { Connector } from "../engine/connectors";
import { EMAIL_SEND } from "./email";
import { GITHUB_COMMENT_CREATE, GITHUB_ISSUE_CLOSE, GITHUB_ISSUE_CREATE, GITHUB_LABELS_ADD } from "./github";
import { WEBHOOK_SEND } from "./webhook";

export const BUILTIN_CONNECTORS: readonly Connector[] = [
  EMAIL_SEND,
  GITHUB_ISSUE_CREATE,
  GITHUB_COMMENT_CREATE,
  GITHUB_LABELS_ADD,
  GITHUB_ISSUE_CLOSE,
  WEBHOOK_SEND,
] as unknown as readonly Connector[];
