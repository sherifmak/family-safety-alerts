import type { Env, Phone, CheckInStatus } from "./types";
import { getFamilyMember } from "./kv";
import { loadActiveIncident } from "./incident";

/** Pattern to strip from body text before capturing as a follow-up message. */
const NOISE_PATTERN =
  /^(help|sos|emergency|trapped|injured|need help|save me|safe|ok|okay|sound|fine|alright|all good|im safe|i'm safe|salim|salem|bkhair|bekhair|ana bkhair)[.!?\s]*$/i;

// Loose matchers for free-text replies from people who don't tap the button.
// Covers English and a few transliterated Arabic forms ("ana bkhair", "salim").
const SAFE_PATTERN =
  /\b(safe|ok|okay|sound|fine|alright|all good|im safe|i'm safe|salim|salem|bkhair|bekhair|ana bkhair)\b/i;
const HELP_PATTERN = /\b(help|sos|emergency|trapped|injured|need help|save me)\b/i;

/**
 * Process an inbound message from an enrolled family member.
 *
 * If the message is a button tap or recognizable "safe"/"help" free-text
 * response, forward it to the open incident's Durable Object. Otherwise, return
 * a reply asking them to tap the button. Returns the reply string the webhook
 * should send back, or `null` if the Incident DO will handle replies via the
 * status board broadcast.
 */
export async function handleFamilyMessage(
  env: Env,
  sender: Phone,
  body: string,
  messageSid: string,
  buttonPayload: string | undefined,
): Promise<string | null> {
  const member = await getFamilyMember(env, sender);
  if (!member) {
    return (
      "Hi! I'm the family safety bot. Your number isn't enrolled yet — " +
      `ask the admin to run \`enroll ${sender} <your name>\`.`
    );
  }

  const active = await loadActiveIncident(env);
  const status = resolveStatus(body, buttonPayload);

  if (!status) {
    // Known member but we can't figure out what they meant. Only instruct
    // them to tap SAFE/NEED HELP if there's actually an active alert —
    // otherwise the prompt bait-and-switches them into responding to a
    // ghost incident.
    if (!active) {
      return (
        `Hi ${member.name}! You're enrolled in the family safety check-in. ` +
        "You'll only hear from me if there's an alert — nothing to do right now."
      );
    }
    return (
      "Got it — if you're responding to the active alert, please tap SAFE or " +
      "NEED HELP on the alert message above, or reply with the word 'safe' or 'help'."
    );
  }

  // Status is "safe" or "help".
  if (!active) {
    return "Thanks, but there's no active alert right now. Your message has been noted.";
  }

  const stub = env.INCIDENT.get(env.INCIDENT.idFromString(active.id));

  // If the sender already checked in as HELP, capture follow-up text.
  const existing = active.state.responses[sender];
  if (existing?.status === "help" && body && !NOISE_PATTERN.test(body.trim())) {
    const msgResult = await stub.recordMessage(messageSid, sender, body.trim());
    if (msgResult.deduped) return null;
    return msgResult.ok ? "💬 Got it — status board updated." : null;
  }

  const result = await stub.recordResponse(messageSid, sender, status);

  if (!result.ok) {
    console.error(`recordResponse failed for ${sender}:`, result.error);
    return "We got your reply but couldn't record it. Please try tapping the button again.";
  }

  if (result.deduped) return null;

  // After recording a HELP check-in, prompt for location.
  if (status === "help") {
    return (
      "📍 Can you share your location? Tap ＋ (or the paperclip icon), " +
      "then *Location*, then *Send your current location*. " +
      "This helps us find you faster."
    );
  }

  return null;
}

/**
 * Reply used when a message arrives from a phone that isn't in the FAMILY KV.
 */
export function unknownSenderReply(sender: Phone): string {
  return (
    "Hi! I'm the family safety bot. Your number isn't enrolled yet — " +
    `ask the admin to run \`enroll ${sender} <your name>\` to add you.`
  );
}

/**
 * Handle an inbound location share. If the sender hasn't checked in yet,
 * auto-record them as HELP (sharing location during an emergency is a clear
 * distress signal). If they already checked in, attach the location to their
 * existing response.
 */
export async function handleLocationShare(
  env: Env,
  sender: Phone,
  messageSid: string,
  location: { lat: number; lon: number; address?: string },
): Promise<string | null> {
  const active = await loadActiveIncident(env);
  if (!active) return null;

  const stub = env.INCIDENT.get(env.INCIDENT.idFromString(active.id));
  const existing = active.state.responses[sender];

  // No prior check-in → auto-mark as HELP, then attach location.
  if (!existing) {
    const resp = await stub.recordResponse(messageSid, sender, "help");
    if (!resp.ok) {
      console.error(`recordResponse (auto-help) failed for ${sender}:`, resp.error);
      return null;
    }
    // recordResponse consumed the messageSid for dedupe. Use a derived sid
    // for the location so it isn't skipped by the processed_webhooks check.
    const locResult = await stub.recordLocation(`${messageSid}:loc`, sender, location);
    if (!locResult.ok) {
      console.error(`recordLocation failed for ${sender}:`, locResult.error);
    }
    return "📍 Location received — we've marked you as needing help. The status board has been updated.";
  }

  // Already checked in — just attach location.
  const locResult = await stub.recordLocation(messageSid, sender, location);
  if (!locResult.ok) {
    console.error(`recordLocation failed for ${sender}:`, locResult.error);
    return null;
  }
  if (locResult.deduped) return null;

  return "📍 Location received — the status board has been updated.";
}

function resolveStatus(body: string, buttonPayload?: string): CheckInStatus | null {
  if (buttonPayload) {
    const p = buttonPayload.trim().toUpperCase();
    if (p === "SAFE") return "safe";
    if (p === "HELP") return "help";
  }
  if (!body) return null;
  if (HELP_PATTERN.test(body)) return "help";
  if (SAFE_PATTERN.test(body)) return "safe";
  return null;
}
