import type { Env, Phone, FamilyMember, IncidentState } from "./types";
import {
  listFamily,
  listOptedInFamily,
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
import { sendTemplate, sendStaggered, createContentTemplate } from "./twilio";

const WELCOME_TEMPLATE_KEY = "_welcome_template_sid";

// English-only welcome body. To add a second language, append it after a
// "\n\n---\n\n" separator with the same {{1}} placeholder for the member name.
const WELCOME_BODY =
  "Hi {{1}}! You've been added to the family safety check-in. " +
  "When there's an alert, you'll get a message with SAFE and NEED HELP buttons — " +
  "just tap one to check in. No action needed until then.";

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
  messageSid: string,
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
    case "test":
      return await testAlertCommand(env, sender, args);
    case "cancel":
      return await cancelCommand(env);
    case "announce":
      return await announceCommand(env, sender, args, messageSid);
    case "welcome":
      return await setupWelcomeCommand(env, sender, args);
    case "unwelcome":
      return await clearWelcomeCommand(env);
    case "reconfirm":
      return await reconfirmCommand(env, sender, args);
    default:
      return helpText();
  }
}

function helpText(): string {
  return [
    "Admin commands:",
    "• alert <pin> [message] — fire an alert (10s cancel window)",
    "• alert <pin> force [message] — skip the 5-minute rate limit",
    "• test <pin> [message] — fire a test alert (only you receive it)",
    "• cancel — cancel a pending alert",
    "• announce <pin> <message> — send an announcement to all members",
    "• status — show check-in status for the most recent incident",
    "• enroll <phone> <name> — add a family member",
    "• remove <phone> — remove a family member",
    "• list — show all enrolled family members",
    "• welcome <pin> — create the welcome template (one-time setup)",
    "• unwelcome — remove the welcome template",
    "• reconfirm <pin> — send welcome message to all pending members to request opt-in",
    "• help — show this message",
  ].join("\n");
}

async function listCommand(env: Env): Promise<string> {
  const family = await listFamily(env);
  if (family.length === 0) return "No family members enrolled yet.";
  let optedIn = 0;
  let pending = 0;
  const lines: string[] = [];
  for (const { phone, member } of family) {
    const isPending = member.opted_in !== true;
    if (isPending) pending++;
    else optedIn++;
    const tag = isPending ? " [pending]" : "";
    lines.push(`• ${member.name} (${phone})${member.is_admin ? " [admin]" : ""}${tag}`);
  }
  const header = `${family.length} enrolled (${optedIn} active, ${pending} pending):`;
  return [header, ...lines].join("\n");
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
    opted_in: existing ? existing.opted_in : false,
  };
  await putFamilyMember(env, phone, member);

  if (existing) return `Updated ${name} (${phone}).`;

  // Send welcome message to new member if template is configured.
  let welcomeNote = "";
  const welcomeSid = await env.FAMILY.get(WELCOME_TEMPLATE_KEY);
  if (welcomeSid) {
    try {
      await sendTemplate(env, phone, welcomeSid, { "1": name });
      welcomeNote = " Welcome message sent.";
    } catch {
      welcomeNote = " (welcome message failed to send)";
    }
  }
  return `Enrolled ${name} (${phone}).${welcomeNote}`;
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

  const family = await listOptedInFamily(env);
  const scopedFamily = state.test
    ? family.filter(({ phone: p }) => p === state.triggered_by)
    : family;
  const responseValues = Object.values(state.responses);
  const safeCount = responseValues.filter((r) => r.status === "safe").length;
  const helpCount = responseValues.filter((r) => r.status === "help").length;
  const triggeredAt = new Date(state.triggered_at).toLocaleString("en-GB", {
    timeZone: "Asia/Beirut",
  });

  const prefix = state.test ? "🧪 TEST — " : "";
  const lines = [
    `${prefix}Latest incident: ${triggeredAt} Beirut`,
    `Responses: ${responseValues.length}/${scopedFamily.length} (${safeCount} safe, ${helpCount} need help)`,
    "",
  ];
  for (const { phone, member } of scopedFamily) {
    const resp = state.responses[phone];
    if (!resp) {
      lines.push(`⏳ ${member.name}`);
    } else if (resp.status === "safe") {
      lines.push(`✅ ${member.name}`);
    } else {
      let helpLine = `🆘 ${member.name} NEEDS HELP`;
      if (resp.message) {
        helpLine += `\n   💬 ${resp.message}`;
      }
      if (resp.location) {
        helpLine += `\n   📍 https://maps.google.com/maps?q=${resp.location.lat},${resp.location.lon}`;
      }
      lines.push(helpLine);
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
  const messageStart = force ? 2 : 1;
  const message = args.slice(messageStart).join(" ").trim() || undefined;

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

  const family = await listOptedInFamily(env);
  if (family.length === 0) {
    return "No opted-in family members to alert. Use `enroll <phone> <name>` and ask them to message the bot first.";
  }

  const doId = env.INCIDENT.newUniqueId();
  const stub = env.INCIDENT.get(doId);
  const queued = await stub.queueAlert(sender, false, message);
  if (!queued.ok) {
    return `Failed to queue alert (${queued.error ?? "unknown"}). Try again.`;
  }

  await setOpenIncidentId(env, doId.toString());
  await setLastAlertTime(env, Date.now());
  await incrementMonthlyAlertCount(env);

  const msgNote = message ? `\n📝 ${message}` : "";
  return (
    `Firing alert to ${family.length} family member${family.length === 1 ? "" : "s"} ` +
    `in 10 seconds. Reply \`cancel\` within 10 seconds to abort.${msgNote}`
  );
}

async function testAlertCommand(env: Env, sender: Phone, args: string[]): Promise<string> {
  if (args.length < 1) {
    return "Usage: test <pin>";
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

  // Don't queue a second incident if one is still pending.
  const existingId = await getOpenIncidentId(env);
  if (existingId) {
    const stub = env.INCIDENT.get(env.INCIDENT.idFromString(existingId));
    const state = await stub.getState();
    if (state && !state.fired && !state.cancelled) {
      return "An alert is already pending. Reply `cancel` to abort it, or wait for it to fire.";
    }
  }

  const message = args.slice(1).join(" ").trim() || undefined;

  const doId = env.INCIDENT.newUniqueId();
  const stub = env.INCIDENT.get(doId);
  const queued = await stub.queueAlert(sender, true, message);
  if (!queued.ok) {
    return `Failed to queue test alert (${queued.error ?? "unknown"}). Try again.`;
  }

  await setOpenIncidentId(env, doId.toString());
  // Intentionally skip setLastAlertTime and incrementMonthlyAlertCount —
  // test alerts don't count against rate limits or monthly caps.

  const msgNote = message ? `\n📝 ${message}` : "";
  return `🧪 Test alert queued — only you will receive it. Reply \`cancel\` within 10 seconds to abort.${msgNote}`;
}

async function announceCommand(env: Env, sender: Phone, args: string[], messageSid: string): Promise<string> {
  if (args.length < 2) {
    return "Usage: announce <pin> <message>\nExample: announce 1234 Water is back on";
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

  if (!env.TWILIO_ANNOUNCE_TEMPLATE_SID) {
    return "Announcements are not configured. Set the TWILIO_ANNOUNCE_TEMPLATE_SID secret first.";
  }

  const message = args.slice(1).join(" ").trim();
  if (!message) {
    return "Message cannot be empty. Usage: announce <pin> <message>";
  }

  // Idempotency: skip re-execution on Twilio webhook retries.
  const dedupKey = `announce:${messageSid}`;
  const cached = await env.RATE_LIMIT.get(dedupKey);
  if (cached) return cached;

  const family = await listOptedInFamily(env);
  if (family.length === 0) {
    return "No opted-in family members. Use `enroll <phone> <name>` and ask them to message the bot first.";
  }

  const results = await sendStaggered(
    family.map(({ phone }) =>
      () => sendTemplate(env, phone, env.TWILIO_ANNOUNCE_TEMPLATE_SID!, { "1": message }),
    ),
  );

  let delivered = 0;
  results.forEach((r) => {
    if (r.status === "fulfilled") delivered++;
  });

  const reply = `📢 Announcement sent to ${delivered}/${family.length} family member${family.length === 1 ? "" : "s"}.\n📝 ${message}`;

  // Cache the response so retries return the same reply without re-sending.
  await env.RATE_LIMIT.put(dedupKey, reply, { expirationTtl: 300 });

  return reply;
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

async function setupWelcomeCommand(env: Env, sender: Phone, args: string[]): Promise<string> {
  if (args.length < 1) return "Usage: welcome <pin>";

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

  const existing = await env.FAMILY.get(WELCOME_TEMPLATE_KEY);
  if (existing) {
    return `Welcome template already configured (${existing}). Run \`unwelcome\` first to recreate.`;
  }

  try {
    const sid = await createContentTemplate(
      env,
      "family_safety_welcome",
      "en",
      WELCOME_BODY,
      { "1": "Sara" },
    );
    await env.FAMILY.put(WELCOME_TEMPLATE_KEY, sid);
    return (
      `Welcome template created (${sid}). ` +
      "It needs WhatsApp approval — usually takes minutes to hours. " +
      "Once approved, new enrollments will auto-send a welcome message."
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to create welcome template: ${msg}`;
  }
}

async function clearWelcomeCommand(env: Env): Promise<string> {
  await env.FAMILY.delete(WELCOME_TEMPLATE_KEY);
  return "Welcome template cleared. New enrollments won't send a welcome message.";
}

async function reconfirmCommand(env: Env, sender: Phone, args: string[]): Promise<string> {
  if (args.length < 1) return "Usage: reconfirm <pin>";

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

  const welcomeSid = await env.FAMILY.get(WELCOME_TEMPLATE_KEY);
  if (!welcomeSid) {
    return "No welcome template configured. Run `welcome <pin>` first.";
  }

  const family = await listFamily(env);
  const pending = family.filter(({ member }) => member.opted_in !== true);
  if (pending.length === 0) {
    return "All members are already opted in.";
  }

  const results = await sendStaggered(
    pending.map(({ phone, member }) =>
      () => sendTemplate(env, phone, welcomeSid, { "1": member.name }),
    ),
  );

  let sent = 0;
  results.forEach((r) => {
    if (r.status === "fulfilled") sent++;
  });

  return `📨 Welcome message sent to ${sent}/${pending.length} pending member${pending.length === 1 ? "" : "s"}. They'll be activated once they reply.`;
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
