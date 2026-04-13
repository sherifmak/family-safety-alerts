import type { Env, Phone } from "./types";
import { verifyWebhookSignature, sendText } from "./twilio";
import { getFamilyMember, putFamilyMember, listFamily } from "./kv";
import { handleAdminCommand } from "./commands";
import { handleFamilyMessage, handleLocationShare, unknownSenderReply } from "./checkin";

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

  const lat = params.Latitude ? parseFloat(params.Latitude) : undefined;
  const lon = params.Longitude ? parseFloat(params.Longitude) : undefined;
  const location =
    lat !== undefined && lon !== undefined && !isNaN(lat) && !isNaN(lon)
      ? { lat, lon, address: params.Address || undefined }
      : undefined;

  if (!from) {
    // Nothing to do with a message that has no sender.
    return new Response("ok", { status: 200 });
  }

  try {
    const reply = await route(env, from, body, messageSid, buttonPayload, location);
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
  location: { lat: number; lon: number; address?: string } | undefined,
): Promise<string | null> {
  const member = await getFamilyMember(env, from);

  if (!member) {
    // Notify admins that an unknown number messaged the bot.
    notifyAdminsOfUnknownSender(env, from).catch((err) =>
      console.error("failed to notify admins of unknown sender:", err),
    );
    return unknownSenderReply(from);
  }

  // Any message from a member who hasn't opted in yet activates them.
  // This covers both new enrollees (opted_in: false) and existing KV
  // entries that predate the opt-in field (opted_in: undefined).
  if (member.opted_in !== true) {
    member.opted_in = true;
    await putFamilyMember(env, from, member);
  }

  // Location messages are handled separately — a location share during an
  // active incident auto-marks the sender as HELP if they haven't checked in.
  if (location && !buttonPayload) {
    return handleLocationShare(env, from, messageSid, location);
  }

  // Button taps always go through the family check-in path, even if the
  // tapper is an admin (admins may also be family members).
  if (buttonPayload) {
    return handleFamilyMessage(env, from, body, messageSid, buttonPayload);
  }

  // Free-text from an admin → command parser.
  if (member.is_admin) {
    return handleAdminCommand(env, from, body, messageSid);
  }

  // Free-text from a regular family member → check-in path (may still match
  // "safe" or "help" patterns during an active incident).
  return handleFamilyMessage(env, from, body, messageSid, undefined);
}

/**
 * Send a heads-up to all admins when an unknown number messages the bot.
 * Fire-and-forget — failures are logged but don't block the sender's reply.
 */
async function notifyAdminsOfUnknownSender(env: Env, sender: Phone): Promise<void> {
  const family = await listFamily(env);
  const admins = family.filter(({ member }) => member.is_admin);
  for (const { phone } of admins) {
    try {
      await sendText(
        env,
        phone,
        `New number ${sender} just messaged the bot but isn't enrolled.\n` +
          `To add them: enroll ${sender} <name>`,
      );
    } catch (err) {
      console.error(`failed to notify admin ${phone} of unknown sender:`, err);
    }
  }
}
