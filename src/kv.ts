import type { Env, Phone, FamilyMember } from "./types";

// ---------- Family roster ----------

export async function getFamilyMember(env: Env, phone: Phone): Promise<FamilyMember | null> {
  const raw = await env.FAMILY.get(phone);
  return raw ? (JSON.parse(raw) as FamilyMember) : null;
}

export async function putFamilyMember(env: Env, phone: Phone, member: FamilyMember): Promise<void> {
  await env.FAMILY.put(phone, JSON.stringify(member));
}

export async function deleteFamilyMember(env: Env, phone: Phone): Promise<void> {
  await env.FAMILY.delete(phone);
}

export async function listFamily(
  env: Env,
): Promise<Array<{ phone: Phone; member: FamilyMember }>> {
  const result: Array<{ phone: Phone; member: FamilyMember }> = [];
  let cursor: string | undefined;
  // KV list is paginated; loop until done. For a family this is one page.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await env.FAMILY.list({ cursor });
    for (const key of page.keys) {
      if (key.name.startsWith("_")) continue; // skip metadata keys
      const member = await getFamilyMember(env, key.name);
      if (member) result.push({ phone: key.name, member });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return result;
}

/**
 * Like listFamily but only returns members who have explicitly opted in
 * (i.e., messaged the bot at least once). Only members with opted_in === true
 * are included. Existing KV entries without the field are treated as NOT
 * opted in — they must message the bot once to activate.
 */
export async function listOptedInFamily(
  env: Env,
): Promise<Array<{ phone: Phone; member: FamilyMember }>> {
  const all = await listFamily(env);
  return all.filter(({ member }) => member.opted_in === true);
}

// ---------- Alert rate limiting ----------

export async function getLastAlertTime(env: Env): Promise<number> {
  const raw = await env.RATE_LIMIT.get("last_alert");
  return raw ? parseInt(raw, 10) : 0;
}

export async function setLastAlertTime(env: Env, ts: number): Promise<void> {
  await env.RATE_LIMIT.put("last_alert", String(ts));
}

function currentMonthKey(): string {
  return `month:${new Date().toISOString().slice(0, 7)}`;
}

export async function getMonthlyAlertCount(env: Env): Promise<number> {
  const raw = await env.RATE_LIMIT.get(currentMonthKey());
  return raw ? parseInt(raw, 10) : 0;
}

export async function incrementMonthlyAlertCount(env: Env): Promise<number> {
  const key = currentMonthKey();
  const next = (await getMonthlyAlertCount(env)) + 1;
  // Expire after ~2 months so old months clean themselves up.
  await env.RATE_LIMIT.put(key, String(next), { expirationTtl: 60 * 60 * 24 * 62 });
  return next;
}

// ---------- Open incident routing ----------

// The webhook uses this to find the incident a button-tap belongs to.
export async function getOpenIncidentId(env: Env): Promise<string | null> {
  return env.RECENT_INCIDENTS.get("open");
}

export async function setOpenIncidentId(env: Env, id: string): Promise<void> {
  // 48h TTL: incidents should resolve well within that.
  await env.RECENT_INCIDENTS.put("open", id, { expirationTtl: 60 * 60 * 48 });
}

export async function clearOpenIncidentId(env: Env): Promise<void> {
  await env.RECENT_INCIDENTS.delete("open");
}

// ---------- Admin PIN brute-force protection ----------

export async function isLockedOut(env: Env, phone: Phone): Promise<boolean> {
  const locked = await env.AUTH_FAIL_COUNTS.get(`lock:${phone}`);
  return locked !== null;
}

export async function lockOut(env: Env, phone: Phone): Promise<void> {
  await env.AUTH_FAIL_COUNTS.put(`lock:${phone}`, "1", { expirationTtl: 60 * 60 * 24 });
}

export async function incrementAuthFail(env: Env, phone: Phone): Promise<number> {
  const key = `fail:${phone}`;
  const raw = await env.AUTH_FAIL_COUNTS.get(key);
  const next = raw ? parseInt(raw, 10) + 1 : 1;
  // Fail counts reset after 1 hour if no further failures.
  await env.AUTH_FAIL_COUNTS.put(key, String(next), { expirationTtl: 60 * 60 });
  return next;
}

export async function clearAuthFails(env: Env, phone: Phone): Promise<void> {
  await env.AUTH_FAIL_COUNTS.delete(`fail:${phone}`);
}
