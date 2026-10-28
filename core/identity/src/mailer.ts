/**
 * Identity's email: one job, sending a sign-in code or a notice to one address, from IDENTITY_SMTP_FROM.
 * The SMTP itself is @asafarim/smtp (TLS or STARTTLS required, AUTH only over TLS, a deadline on every step).
 * Nothing it logs or throws contains the address, the code or the password.
 */
import { SmtpClient, type SmtpConfig } from "@asafarim/smtp";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly client: SmtpClient;
  private readonly from: string;

  /** `from`: `ASafariM <no-reply@asafarim.site>` or a bare address. */
  constructor(config: SmtpConfig & { from: string }) {
    const { from, ...smtp } = config;
    this.client = new SmtpClient(smtp);
    this.from = from;
  }

  async send(message: MailMessage): Promise<void> {
    await this.client.send({ from: this.from, to: [message.to], subject: message.subject, text: message.text });
  }
}

/**
 * Development only (config refuses it unless NODE_ENV=development on
 * localhost): writes the first line of the message to stderr instead of
 * sending it.
 */
export class DevLogMailer implements Mailer {
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)) {
    this.write = write;
  }

  async send(message: MailMessage): Promise<void> {
    this.write(`[dev email] to ${message.to}: ${message.subject}`);
  }
}
