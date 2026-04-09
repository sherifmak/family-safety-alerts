import type { Env, Phone, CheckInStatus } from "./types";
import { getFamilyMember } from "./kv";
import { loadActiveIncident } from "./incident";

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
  const result = await stub.recordResponse(messageSid, sender, status);

  if (!result.ok) {
    console.error(`recordResponse failed for ${sender}:`, result.error);
    return "We got your reply but couldn't record it. Please try tapping the button again.";
  }

  // The Incident DO sends the status board to this recipient as part of the
  // broadcast, so we don't need to send a separate "thanks" reply here — it
  // would just produce a noisy two-message sequence in the chat.
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
