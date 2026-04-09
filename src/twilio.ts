import type { Env, Phone } from "./types";

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";

function toWhatsApp(phone: Phone): string {
  return phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
}

function authHeader(env: Env): string {
  const creds = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  return `Basic ${creds}`;
}

/**
 * Send a free-form text message. Only valid inside an open 24-hour customer
 * service window (i.e., after the recipient has sent an inbound message).
 * Returns the Twilio MessageSid.
 */
export async function sendText(env: Env, to: Phone, body: string): Promise<string> {
  const params = new URLSearchParams({
    From: env.TWILIO_FROM,
    To: toWhatsApp(to),
    Body: body,
  });
  return twilioPost(env, `/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, params);
}

/**
 * Send an approved Content Template. Works regardless of window state.
 * This is the only way to reach someone outside the 24h window.
 */
export async function sendTemplate(
  env: Env,
  to: Phone,
  contentSid: string,
  contentVariables?: Record<string, string>,
): Promise<string> {
  const params = new URLSearchParams({
    From: env.TWILIO_FROM,
    To: toWhatsApp(to),
    ContentSid: contentSid,
  });
  if (contentVariables) {
    params.set("ContentVariables", JSON.stringify(contentVariables));
  }
  return twilioPost(env, `/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, params);
}

async function twilioPost(env: Env, path: string, params: URLSearchParams): Promise<string> {
  const res = await fetch(`${TWILIO_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio POST ${path} failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { sid: string };
  return data.sid;
}

/**
 * Verify Twilio's X-Twilio-Signature header.
 *
 * Twilio signature algorithm:
 *   HMAC-SHA1(authToken, fullRequestURL + sortedKey1 + sortedValue1 + ...)
 * then base64-encoded.
 *
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export async function verifyWebhookSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<boolean> {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const sigBytes = new Uint8Array(sigBuffer);

  // Base64-encode without spreading (avoids stack issues on large inputs).
  let binary = "";
  for (let i = 0; i < sigBytes.length; i++) {
    binary += String.fromCharCode(sigBytes[i]);
  }
  const computed = btoa(binary);

  // Constant-time compare.
  if (computed.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
