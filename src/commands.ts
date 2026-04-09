import type { Env, Phone, FamilyMember, IncidentState } from "./types";
import {
  listFamily,
  putFamilyMember,
  deleteFamilyMember,
  getFamilyMember,
  getLastAlertTime,
  setLastAlertTime,
  getOpenIncidentId,
  setOpenIncidentId,
  clearOpenIncidentId,
  incrementAuthFail,
  isLockedOut,
  lockOut,
  clearAuthFails,
  getMonthlyAlertCount,
  incrementMonthlyAlertCount,
} from "./kv";
import { loadActiveIncident } from "./incident";

const RATE_LIMIT_MS = 5 * 60 * 1000;
const MAX_AUTH_FAILS = 3;

/**
 * Dispatch an admin command. Returns the reply text to send back, or `null`
 * if no reply should be sent.
 */
export async function handleAdminCommand(
  env: Env,
  sender: Phone,
  body: string,
): Promise<string | null> {
  if (await isLockedOut(env, sender)) {
    return "You are temporarily locked out due to repeated failed authentication. Try again in 24 hours.";
  }

  const admin = await getFamilyMember(env, sender);
  if (!admin || !admin.is_admin) {
    return "Unknown command. Wait for an alert and tap SAFE or NEED HELP.";
  }

  const parts = body.trim().split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "help":
      return helpText();
    case "list":
      return await listCommand(env);
    case "enroll":
      return await enrollCommand(env, args);
    case "remove":
      return await removeCommand(env, args);
    case "status":
      return await statusCommand(env);
    case "alert":
      return await alertCommand(env, sender, args);
    case "cancel":
      return await cancelCommand(env);
    default:
      return helpText();
  }
}

function helpText(): string {
  return [
    "Admin commands:",
    "• alert <pin> — fire an alert to all family members (10s cancel window)",
    "• alert <pin> force — skip the 5-minute rate limit",
    "• cancel — cancel a pending alert",
    "• status — show check-in status for the most recent incident",
    "• enroll <phone> <name> — add a family member",
    "• remove <phone> — remove a family member",
    "• list — show all enrolled family members",
    "• help — show this message",
  ].join("\n");
}

async function listCommand(env: Env): Promise<string> {
  const family = await listFamily(env);
  if (family.length === 0) return "No family members enrolled yet.";
  const lines = [`${family.length} enrolled:`];
  for (const { phone, member } of family) {
    lines.push(`• ${member.name} (${phone})${member.is_admin ? " [admin]" : ""}`);
  }
  return lines.join("\n");
}

async function enrollCommand(env: Env, args: string[]): Promise<string> {
  if (args.length < 2) {
    return "Usage: enroll <phone> <name>\nExample: enroll +9611234567 Sara";
  }
  const phone = normalizePhone(args[0]);
  if (!phone) {
    return "Invalid phone format. Use E.164, e.g., +9611234567";
  }
  const name = args.slice(1).join(" ");

  const existing = await getFamilyMember(env, phone);
  const member: FamilyMember = {
    name,
    joined_at: existing?.joined_at ?? Date.now(),
    is_admin: existing?.is_admin ?? false,
  };
  await putFamilyMember(env, phone, member);
  return existing ? `Updated ${name} (${phone}).` : `Enrolled ${name} (${phone}).`;
}

async function removeCommand(env: Env, args: string[]): Promise<string> {
  if (args.length < 1) return "Usage: remove <phone>";
  const phone = normalizePhone(args[0]);
  if (!phone) return "Invalid phone format.";
  const existing = await getFamilyMember(env, phone);
  if (!existing) return `${phone} is not enrolled.`;
  if (existing.is_admin) {
    return "Cannot remove an admin via WhatsApp. Use `wrangler kv key delete` instead.";
  }
  await deleteFamilyMember(env, phone);
  return `Removed ${existing.name} (${phone}).`;
}

async function statusCommand(env: Env): Promise<string> {
  const active = await loadActiveIncident(env);
  if (!active) return "No active incident.";
  const state = active.state;

  const family = await listFamily(env);
  const responseValues = Object.values(state.responses);
  const safeCount = responseValues.filter((r) => r.status === "safe").length;
  const helpCount = responseValues.filter((r) => r.status === "help").length;
  const triggeredAt = new Date(state.triggered_at).toLocaleString("en-GB", {
    timeZone: "Asia/Beirut",
  });

  const lines = [
    `Latest incident: ${triggeredAt}`,
    `Responses: ${responseValues.length}/${family.length} (${safeCount} safe, ${helpCount} need help)`,
    "",
  ];
  for (const { phone, member } of family) {
    const resp = state.responses[phone];
    if (!resp) {
      lines.push(`⏳ ${member.name}`);
    } else if (resp.status === "safe") {
      lines.push(`✅ ${member.name}`);
    } else {
      lines.push(`🆘 ${member.name} NEEDS HELP`);
    }
  }
  return lines.join("\n");
}

async function alertCommand(env: Env, sender: Phone, args: string[]): Promise<string> {
  if (args.length < 1) {
    return "Usage: alert <pin> [force]";
  }

  const pin = args[0];
  if (pin !== env.ADMIN_PIN) {
    const fails = await incrementAuthFail(env, sender);
    if (fails >= MAX_AUTH_FAILS) {
      await lockOut(env, sender);
      return "Too many failed attempts. You are locked out for 24 hours.";
    }
    return "Unknown command.";
  }
  await clearAuthFails(env, sender);

  const force = args[1]?.toLowerCase() === "force";

  // Monthly cap (cost control).
  if (env.MAX_ALERTS_PER_MONTH) {
    const cap = parseInt(env.MAX_ALERTS_PER_MONTH, 10);
    if (Number.isFinite(cap) && cap > 0) {
      const used = await getMonthlyAlertCount(env);
      if (used >= cap) {
        return `Monthly alert cap reached (${used}/${cap}). Raise MAX_ALERTS_PER_MONTH or wait until next month.`;
      }
    }
  }

  // 5-minute rate limit.
  if (!force) {
    const lastAlert = await getLastAlertTime(env);
    const sinceLast = Date.now() - lastAlert;
    if (sinceLast < RATE_LIMIT_MS) {
      const remaining = Math.ceil((RATE_LIMIT_MS - sinceLast) / 1000);
      return (
        `Recent alert already sent ${Math.ceil(sinceLast / 1000)}s ago. ` +
        `Wait ${remaining}s or reply \`alert <pin> force\` to override.`
      );
    }
  }

  // Don't queue a second incident if one is still pending.
  const existingId = await getOpenIncidentId(env);
  if (existingId) {
    const stub = env.INCIDENT.get(env.INCIDENT.idFromString(existingId));
    const state = await stub.getState();
    if (state && !state.fired && !state.cancelled) {
      return "An alert is already pending. Reply `cancel` to abort it, or wait for it to fire.";
    }
  }

  const family = await listFamily(env);
  if (family.length === 0) {
    return "No family members enrolled to alert. Use `enroll <phone> <name>` first.";
  }

  const doId = env.INCIDENT.newUniqueId();
  const stub = env.INCIDENT.get(doId);
  const queued = await stub.queueAlert(sender);
  if (!queued.ok) {
    return `Failed to queue alert (${queued.error ?? "unknown"}). Try again.`;
  }

  await setOpenIncidentId(env, doId.toString());
  await setLastAlertTime(env, Date.now());
  await incrementMonthlyAlertCount(env);

  return (
    `Firing alert to ${family.length} family member${family.length === 1 ? "" : "s"} ` +
    `in 10 seconds. Reply \`cancel\` within 10 seconds to abort.`
  );
}

async function cancelCommand(env: Env): Promise<string> {
  const incidentIdStr = await getOpenIncidentId(env);
  if (!incidentIdStr) return "No pending alert to cancel.";

  const stub = env.INCIDENT.get(env.INCIDENT.idFromString(incidentIdStr));
  const result = await stub.cancel();
  if (result.ok) {
    await clearOpenIncidentId(env);
    return "Alert cancelled. No messages were sent.";
  }
  if (result.error === "already_fired") {
    return "Too late — the alert has already been sent.";
  }
  return `Failed to cancel: ${result.error ?? "unknown error"}`;
}

function normalizePhone(raw: string): Phone | null {
  // Strip formatting characters, keep + and digits.
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (!cleaned.startsWith("+")) return null;
  if (cleaned.length < 8) return null;
  return cleaned;
}

// Re-exported for tests / potential future use.
export type { IncidentState };
