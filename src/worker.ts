import type { Env, Phone } from "./types";
import { verifyWebhookSignature, sendText } from "./twilio";
import { getFamilyMember } from "./kv";
import { handleAdminCommand } from "./commands";
import { handleFamilyMessage, unknownSenderReply } from "./checkin";

// Durable Object class must be re-exported from the entry module so wrangler
// can wire it up.
export { Incident } from "./incident";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();

  // Verify Twilio signature before touching any state. Twilio signs the full
  // request URL plus the sorted form-encoded params.
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) {
    return new Response("missing signature", { status: 401 });
  }

  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(bodyText)) {
    params[k] = v;
  }

  const valid = await verifyWebhookSignature(
    env.TWILIO_AUTH_TOKEN,
    request.url,
    params,
    signature,
  );
  if (!valid) {
    return new Response("invalid signature", { status: 401 });
  }

  // Extract WhatsApp fields. Twilio strips "whatsapp:" when sending webhooks
  // for the From field in some cases but not others — normalize defensively.
  const from = (params.From ?? "").replace(/^whatsapp:/, "") as Phone;
  const body = params.Body ?? "";
  const messageSid = params.MessageSid ?? params.SmsMessageSid ?? "";
  const buttonPayload = params.ButtonPayload;

  if (!from) {
    // Nothing to do with a message that has no sender.
    return new Response("ok", { status: 200 });
  }

  try {
    const reply = await route(env, from, body, messageSid, buttonPayload);
    if (reply) {
      // Send the reply out-of-band via the REST API rather than returning
      // TwiML. This keeps the response path uniform for all message types.
      await sendText(env, from, reply);
    }
  } catch (err) {
    // Log but always return 200 — Twilio retries on 5xx, and we don't want to
    // reprocess a message we already partially handled.
    console.error("webhook handler error:", err);
  }

  return new Response("ok", { status: 200 });
}

async function route(
  env: Env,
  from: Phone,
  body: string,
  messageSid: string,
  buttonPayload: string | undefined,
): Promise<string | null> {
  const member = await getFamilyMember(env, from);

  if (!member) {
    return unknownSenderReply(from);
  }

  // Button taps always go through the family check-in path, even if the
  // tapper is an admin (admins may also be family members).
  if (buttonPayload) {
    return handleFamilyMessage(env, from, body, messageSid, buttonPayload);
  }

  // Free-text from an admin → command parser.
  if (member.is_admin) {
    return handleAdminCommand(env, from, body);
  }

  // Free-text from a regular family member → check-in path (may still match
  // "safe" or "help" patterns during an active incident).
  return handleFamilyMessage(env, from, body, messageSid, undefined);
}
