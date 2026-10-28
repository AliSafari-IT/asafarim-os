/**
 * `email.send`: a plain-text message through the smtp credential's server (lib/egress/smtp.ts), in this
 * order, each refusal before anything is sent:
 *
 *   1. every recipient is on Settings `email_recipients` (the address, or its "@domain"), else
 *      `recipient_not_allowed`, before the credential is even opened or a server reached;
 *   2. the credential (`smtp`): host, port, mode, from, username, password;
 *   3. the rate limits, in `email_sends`: 100 a day per workflow, 500 a day in all (the last 24 hours),
 *      else `rate_limited`. A step holds one place: called again (a retry, or after a crash) it reuses
 *      it; a send that fails gives it back;
 *   4. the send: the server's addresses checked and pinned, `none` (no TLS) for loopback only and never
 *      in production; `smtp_auth` when it refuses the login, `smtp_unavailable` (retryable) when it can't
 *      be reached or answers 4xx, `smtp_rejected` when it refuses for good (5xx).
 *
 * At least once: a crash after the server accepted the message sends it again on the next call.
 */
import { z } from "zod";
import { ConnectorError } from "../engine/connector-error";
import type { Connector, ConnectorContext } from "../engine/connectors";
import { SmtpEgressError } from "../egress/smtp";
import { getSettings, isRecipientAllowed } from "../settings";
import { templatedText } from "../workflow/templates";

export const EMAIL_LIMIT_PER_WORKFLOW = 100;
export const EMAIL_LIMIT_TOTAL = 500;
export const MAX_RECIPIENTS = 10;

const Input = z.strictObject({
  /** The smtp credential's id. */
  credential: z.string().min(1).max(64),
  to: z.array(templatedText(254)).min(1).max(MAX_RECIPIENTS),
  subject: templatedText(200),
  body: templatedText(50_000),
});
const Output = z.strictObject({
  /** The server's id for the message; null when it gave none. */
  messageId: z.string().max(255).nullable(),
  simulated: z.literal(true).optional(),
});
type Input = z.infer<typeof Input>;
type Output = z.infer<typeof Output>;

const SMTP_MESSAGES: Record<SmtpEgressError["code"], string> = {
  paused_all: "Flow is paused (Settings): nothing is sent.",
  dns_failed: "The SMTP server's name didn't resolve.",
  private_address: "The SMTP server resolves to a private or reserved address.",
  insecure_refused: "SMTP without TLS is allowed only for a loopback server, and never in production.",
  smtp_auth: "The SMTP server refused the login.",
  smtp_unavailable: "The SMTP server couldn't be reached, or answered it can't take the message now.",
  smtp_rejected: "The SMTP server refused the message.",
  smtp_tls: "TLS with the SMTP server failed (no STARTTLS, or its certificate).",
  invalid_message: "The message has a line break in a header, or an address that isn't one.",
};

/**
 * Take the step's place in today's sends (or keep the one it holds); false when a limit is reached.
 * Serialized by an advisory lock, so two calls can't both take the last place.
 */
async function reserve(ctx: ConnectorContext): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('flow.email_sends'))");
    const held = (await tx.query("SELECT 1 FROM email_sends WHERE step_id = $1", [ctx.stepId])) as {
      rows: unknown[];
    };
    if (held.rows.length) return true;
    const counts = (await tx.query(
      `SELECT count(*) FILTER (WHERE workflow_id = $1)::int AS workflow, count(*)::int AS total
         FROM email_sends WHERE created_at > now() - interval '1 day'`,
      [ctx.workflowId],
    )) as { rows: { workflow: number; total: number }[] };
    const { workflow, total } = counts.rows[0] ?? { workflow: 0, total: 0 };
    if (workflow >= EMAIL_LIMIT_PER_WORKFLOW || total >= EMAIL_LIMIT_TOTAL) return false;
    await tx.query("INSERT INTO email_sends (step_id, run_id, workflow_id) VALUES ($1, $2, $3)", [
      ctx.stepId,
      ctx.runId,
      ctx.workflowId,
    ]);
    return true;
  });
}

export const EMAIL_SEND: Connector<Input, Output> = {
  type: "email.send",
  input: Input,
  output: Output,
  timeoutMs: 30_000,
  simulate: () => ({ messageId: null, simulated: true }),
  async run(ctx, input) {
    const to = [...new Set(input.to.map((a) => a.trim().toLowerCase()))];
    const subject = input.subject.trim();
    if (!subject) throw new ConnectorError("invalid_request", false, "The subject is empty.");
    if (/[\r\n]/.test(subject)) throw new ConnectorError("invalid_request", false, "The subject has a line break.");
    const { emailRecipients } = await getSettings(ctx.db);
    const refused = to.filter((a) => !isRecipientAllowed(emailRecipients, a)).length;
    if (refused)
      throw new ConnectorError(
        "recipient_not_allowed",
        false,
        `${refused} of ${to.length} recipients aren't on the allowed recipients list (Settings).`,
      );
    const smtp = await ctx.credentials.use(input.credential, "smtp");
    if (!(await reserve(ctx)))
      throw new ConnectorError(
        "rate_limited",
        false,
        `At most ${EMAIL_LIMIT_PER_WORKFLOW} emails a day per workflow and ${EMAIL_LIMIT_TOTAL} in all.`,
      );
    try {
      const sent = await ctx.smtp.send({
        server: {
          host: smtp.host,
          port: smtp.port,
          mode: smtp.mode,
          username: smtp.username,
          password: smtp.password,
        },
        message: { from: smtp.from, to, subject, text: input.body },
      });
      ctx.log.info("flow.email.sent", { recipients: to.length });
      return { messageId: sent.messageId ?? null };
    } catch (err) {
      // Nothing went out: the place is given back (a retry takes it again).
      await ctx.db
        .query("DELETE FROM email_sends WHERE step_id = $1", [ctx.stepId])
        .catch(() => ctx.log.warn("flow.email.release_failed"));
      if (err instanceof SmtpEgressError) throw new ConnectorError(err.code, err.retryable, SMTP_MESSAGES[err.code]);
      throw err;
    }
  },
};
