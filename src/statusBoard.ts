import type { Env, Phone, IncidentState, FamilyMember } from "./types";
import { sendText } from "./twilio";

function beirutTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Beirut",
  });
}

/**
 * Build the text body of the status board for the given incident.
 * Family members are listed in roster order so successive boards are easy
 * to scan and compare.
 */
export function formatStatusBoard(
  state: IncidentState,
  family: Array<{ phone: Phone; member: FamilyMember }>,
): string {
  const lines: string[] = [];
  lines.push(`📋 Status — alert at ${beirutTime(state.triggered_at)}`);
  lines.push("");

  let safe = 0;
  let helpCount = 0;
  for (const { phone, member } of family) {
    const resp = state.responses[phone];
    if (resp?.status === "safe") {
      lines.push(`✅ ${member.name} (${beirutTime(resp.at)})`);
      safe++;
    } else if (resp?.status === "help") {
      lines.push(`🆘 ${member.name} NEEDS HELP (${beirutTime(resp.at)})`);
      helpCount++;
    } else {
      lines.push(`⏳ ${member.name}`);
    }
  }

  lines.push("");
  lines.push(`${safe}/${family.length} safe${helpCount > 0 ? `, ${helpCount} need help` : ""}`);
  return lines.join("\n");
}

/**
 * Send the status board as a fresh message to a single recipient.
 *
 * We don't try to edit previous boards in place — Twilio's WhatsApp edit API
 * has tight constraints and the cleaner fallback is a fresh send, which is
 * what we do here unconditionally.
 */
export async function sendBoard(env: Env, recipient: Phone, body: string): Promise<void> {
  await sendText(env, recipient, body);
}
