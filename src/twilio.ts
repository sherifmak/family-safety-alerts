import type { Env, Phone } from "./types";

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";

/** Delay between sequential sends to avoid triggering WhatsApp bulk-send detection. */
export const STAGGER_DELAY_MS = 500;

/**
 * Execute an array of async tasks sequentially with a delay between each.
 * Returns PromiseSettledResult[] (same shape as Promise.allSettled) so call
 * sites can swap in with minimal changes.
 */
export async function sendStaggered<T>(
  tasks: Array<() => Promise<T>>,
  delayMs: number = STAGGER_DELAY_MS,
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = [];
  for (let i = 0; i < tasks.length; i++) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const value = await tasks[i]();
      results.push({ status: "fulfilled", value });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  return results;
}

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

const TWILIO_CONTENT_BASE = "https://content.twilio.com/v1";

/**
 * Create a Content Template via the Twilio Content API.
 * Returns the ContentSid (HX...).
 */
export async function createContentTemplate(
  env: Env,
  friendlyName: string,
  language: string,
  body: string,
  variables: Record<string, string>,
): Promise<string> {
  const res = await fetch(`${TWILIO_CONTENT_BASE}/Content`, {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      friendly_name: friendlyName,
      language,
      variables,
      types: { "twilio/text": { body } },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio Content API failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { sid: string };
  return data.sid;
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
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Twilio POST ${path} failed (${res.status}): ${text}`);
  }
  try {
    const data = JSON.parse(text) as { sid: string };
    return data.sid;
  } catch {
    // Twilio occasionally returns the SID as plain text.
    const trimmed = text.trim();
    if (/^[A-Z]{2}[0-9a-f]{32}$/.test(trimmed)) return trimmed;
    throw new Error(`Twilio POST ${path}: unexpected response body: ${trimmed.slice(0, 120)}`);
  }
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
