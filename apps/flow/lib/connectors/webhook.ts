/**
 * `webhook.send`: POST a JSON body to a URL whose host is on Settings `egress_hosts`, through lib/egress
 * (HTTPS only, public addresses only, no redirect, 256 KiB out, 10 s), signed with a webhook-secret
 * credential (lib/connectors/webhook-signature.ts):
 *
 *   X-Flow-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 *   X-Flow-Delivery:  <runId>:<stepKey>   the same on every call of the step, for the receiver to dedupe
 *
 * The body is a JSON value written in the definition: placeholders go in its string values only, so data
 * can't change its shape. Errors: `host_not_allowed`, `private_address`, `timeout` (retryable),
 * `http_<status>` (5xx, 408 and 429 retryable).
 */
import { z } from "zod";
import { ConnectorError } from "../engine/connector-error";
import type { Connector } from "../engine/connectors";
import { EgressError, type EgressResponse } from "../egress/egress";
import { allowListOf } from "../egress/hosts";
import { getSettings } from "../settings";
import { credentialField, egressUrl } from "../workflow/fields";
import { templatedText } from "../workflow/templates";
import { egressFailure } from "./failures";
import { DELIVERY_HEADER, SIGNATURE_HEADER, signatureHeader } from "./webhook-signature";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const JsonString = templatedText(10_000);
/** A JSON value; its strings take placeholders, its keys don't. */
const JsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    JsonString,
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue).max(1000),
    z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), JsonValue),
  ]),
);

const Input = z.strictObject({
  url: egressUrl(z.url({ protocol: /^https$/ }).max(2048)),
  /** The webhook-secret credential's id. */
  credential: credentialField("webhook-secret"),
  body: JsonValue,
});
const Output = z.strictObject({ status: z.number().int(), simulated: z.literal(true).optional() });

const RETRYABLE_STATUS = (s: number) => s >= 500 || s === 408 || s === 429;

export const WEBHOOK_SEND: Connector<z.infer<typeof Input>, z.infer<typeof Output>> = {
  type: "webhook.send",
  input: Input,
  output: Output,
  simulate: () => ({ status: 0, simulated: true }),
  async run(ctx, input) {
    const { egressHosts } = await getSettings(ctx.db);
    const { secret } = await ctx.credentials.use(input.credential, "webhook-secret");
    const body = JSON.stringify(input.body);
    const t = Math.floor(Date.now() / 1000);
    let res: EgressResponse;
    try {
      res = await ctx.egress.request({
        method: "POST",
        url: input.url,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "asafarim-flow",
          [SIGNATURE_HEADER]: signatureHeader(secret, body, t),
          [DELIVERY_HEADER]: `${ctx.runId}:${ctx.stepKey}`,
        },
        body,
        allow: allowListOf(egressHosts),
      });
    } catch (err) {
      // A redirect is an answer: reported with its status, not followed.
      if (err instanceof EgressError && err.code === "redirect_refused" && err.status)
        throw new ConnectorError(`http_${err.status}`, false, `${err.message}: redirects aren't followed.`);
      egressFailure(err);
    }
    if (res.status < 200 || res.status >= 300)
      throw new ConnectorError(
        `http_${res.status}`,
        RETRYABLE_STATUS(res.status),
        `The receiver answered ${res.status}.`,
      );
    return { status: res.status };
  },
};
