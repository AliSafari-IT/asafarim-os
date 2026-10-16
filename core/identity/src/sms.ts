/**
 * Sending the sign-in code by SMS. One small interface so the provider can be
 * swapped; Twilio's REST API is called with fetch (no SDK dependency).
 *
 * The message never goes into a log, and neither does the number.
 */
export interface SmsSender {
  /** Resolves when the provider accepted the message; rejects with SmsError otherwise. */
  send(to: string, body: string): Promise<void>;
}

export class SmsError extends Error {
  /** A short reason for the logs: an HTTP status or a provider error code, never the message or number. */
  readonly reason: string;

  constructor(reason: string) {
    super(`SMS not sent (${reason})`);
    this.name = "SmsError";
    this.reason = reason;
  }
}

/**
 * The SMS text. The last line is the WebOTP / one-time-code format
 * (`@<host> #<code>`), so phones offer to fill the code in on that site only.
 */
export function codeMessage(code: string, issuerHost: string, minutes: number): string {
  return `Your ASafariM sign-in code is ${code}. It expires in ${minutes} minutes. Never share it with anyone.\n\n@${issuerHost} #${code}`;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** A sender number (E.164), an alphanumeric sender id, or a Messaging Service SID (`MG…`). */
  from: string;
}

export class TwilioSmsSender implements SmsSender {
  private readonly config: TwilioConfig;
  private readonly fetchFn: typeof fetch;

  constructor(config: TwilioConfig, fetchFn: typeof fetch = fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  async send(to: string, body: string): Promise<void> {
    const { accountSid, authToken, from } = this.config;
    const form = new URLSearchParams({ To: to, Body: body });
    if (/^MG[0-9a-f]{32}$/i.test(from)) form.set("MessagingServiceSid", from);
    else form.set("From", from);
    let res: Response;
    try {
      res = await this.fetchFn(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form,
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        },
      );
    } catch (err) {
      throw new SmsError((err as Error).name === "TimeoutError" ? "timeout" : "network");
    }
    if (res.status !== 201 && res.status !== 200) {
      let code = "";
      try {
        const data = (await res.json()) as { code?: number };
        if (typeof data.code === "number") code = `:${data.code}`;
      } catch {
        // no JSON body: the status is enough
      }
      throw new SmsError(`http_${res.status}${code}`);
    }
  }
}

/**
 * Development only (config refuses it unless NODE_ENV=development): writes the
 * code to the service's stderr instead of sending it, so the flow can be tried
 * without an SMS account. It never runs where real people sign in.
 */
export class DevLogSmsSender implements SmsSender {
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)) {
    this.write = write;
  }

  async send(to: string, body: string): Promise<void> {
    this.write(`[dev sms] to ${to}: ${body.split("\n")[0]}`);
  }
}
