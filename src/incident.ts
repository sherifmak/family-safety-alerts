import { DurableObject } from "cloudflare:workers";
import type { Env, Phone, IncidentState, CheckInStatus } from "./types";
import { listOptedInFamily, getOpenIncidentId, clearOpenIncidentId } from "./kv";
import { sendTemplate, sendStaggered, sendText } from "./twilio";
import { formatStatusBoard, sendBoard } from "./statusBoard";

const CANCEL_WINDOW_MS = 10 * 1000;

// An incident older than this is treated as closed even if the
// RECENT_INCIDENTS "open" pointer still references it. Guards against stale
// pointers misrouting casual family messages into ghost status-board
// broadcasts long after a real alert is over.
const INCIDENT_ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Load the currently-active incident — one that exists, hasn't been
 * cancelled, and was queued within the last INCIDENT_ACTIVE_WINDOW_MS.
 * If the pointer references a missing/cancelled/stale incident, clears the
 * pointer as a side-effect so the next caller sees a clean slate.
 */
export async function loadActiveIncident(
  env: Env,
): Promise<{ id: string; state: IncidentState } | null> {
  const id = await getOpenIncidentId(env);
  if (!id) return null;

  const stub = env.INCIDENT.get(env.INCIDENT.idFromString(id));
  const state = await stub.getState();
  if (!state || state.cancelled) {
    await clearOpenIncidentId(env);
    return null;
  }

  if (Date.now() - state.triggered_at > INCIDENT_ACTIVE_WINDOW_MS) {
    await clearOpenIncidentId(env);
    return null;
  }

  return { id, state };
}

/**
 * One Durable Object instance per incident. Owns the strongly-consistent state
 * for check-ins and the 10-second cancel-window alarm.
 */
export class Incident extends DurableObject<Env> {
  /**
   * Initialize a fresh incident and schedule the 10s cancel-window alarm.
   * Called by the `alert` admin command.
   */
  async queueAlert(triggeredBy: Phone, test?: boolean, message?: string): Promise<{ ok: boolean; error?: string }> {
    const existing = await this.loadState();
    if (existing && (existing.fired || existing.cancelled)) {
      return { ok: false, error: "already_resolved" };
    }
    if (existing && !existing.fired && !existing.cancelled) {
      return { ok: false, error: "already_pending" };
    }

    const state: IncidentState = {
      id: this.ctx.id.toString(),
      triggered_at: Date.now(),
      triggered_by: triggeredBy,
      responses: {},
      processed_webhooks: [],
      fired: false,
      cancelled: false,
      test: !!test || undefined,
      message: message || undefined,
    };
    await this.saveState(state);
    await this.ctx.storage.setAlarm(Date.now() + CANCEL_WINDOW_MS);
    return { ok: true };
  }

  /**
   * Cancel a pending (not-yet-fired) incident. Returns an error if the alarm
   * has already fired.
   */
  async cancel(): Promise<{ ok: boolean; error?: string }> {
    const state = await this.loadState();
    if (!state) return { ok: false, error: "no_incident" };
    if (state.fired) return { ok: false, error: "already_fired" };
    if (state.cancelled) return { ok: true };

    state.cancelled = true;
    await this.saveState(state);
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  /**
   * Record a check-in from a family member and broadcast the updated status
   * board to everyone whose 24-hour service window is open.
   *
   * Dedupes by Twilio MessageSid — Twilio retries webhooks on 5xx responses,
   * so we must be idempotent per inbound message.
   */
  async recordResponse(
    messageSid: string,
    phone: Phone,
    status: CheckInStatus,
  ): Promise<{ ok: boolean; error?: string; deduped?: boolean }> {
    const state = await this.loadState();
    if (!state) return { ok: false, error: "no_incident" };

    if (state.processed_webhooks.includes(messageSid)) {
      return { ok: true, deduped: true };
    }
    state.processed_webhooks.push(messageSid);

    // First response wins — don't let people toggle between safe and help.
    if (!state.responses[phone]) {
      state.responses[phone] = { status, at: Date.now() };
    }
    await this.saveState(state);
    await this.broadcastBoard(state);
    return { ok: true };
  }

  /**
   * Attach a follow-up text message to an existing HELP response and
   * re-broadcast the status board. Latest message wins.
   */
  async recordMessage(
    messageSid: string,
    phone: Phone,
    text: string,
  ): Promise<{ ok: boolean; error?: string; deduped?: boolean }> {
    const state = await this.loadState();
    if (!state) return { ok: false, error: "no_incident" };

    if (state.processed_webhooks.includes(messageSid)) {
      return { ok: true, deduped: true };
    }
    state.processed_webhooks.push(messageSid);

    const resp = state.responses[phone];
    if (!resp) return { ok: false, error: "no_response" };

    resp.message = text;
    await this.saveState(state);
    await this.broadcastBoard(state);
    return { ok: true };
  }

  /**
   * Attach location data to an existing response and re-broadcast the
   * status board. Latest location wins (overwrites previous).
   */
  async recordLocation(
    messageSid: string,
    phone: Phone,
    location: { lat: number; lon: number; address?: string },
  ): Promise<{ ok: boolean; error?: string; deduped?: boolean }> {
    const state = await this.loadState();
    if (!state) return { ok: false, error: "no_incident" };

    if (state.processed_webhooks.includes(messageSid)) {
      return { ok: true, deduped: true };
    }
    state.processed_webhooks.push(messageSid);

    const resp = state.responses[phone];
    if (!resp) return { ok: false, error: "no_response" };

    resp.location = location;
    await this.saveState(state);
    await this.broadcastBoard(state);
    return { ok: true };
  }

  async getState(): Promise<IncidentState | null> {
    return this.loadState();
  }

  /**
   * Fired by Cloudflare 10 seconds after `queueAlert` unless `cancel` was
   * called in the interim. Fans out the template message to every enrolled
   * family member, including the admin who triggered it — the admin may also
   * be in the affected zone and needs a way to formally check in.
   */
  async alarm(): Promise<void> {
    const state = await this.loadState();
    if (!state || state.cancelled || state.fired) return;

    state.fired = true;
    await this.saveState(state);

    const family = await listOptedInFamily(this.env);
    const recipients = state.test
      ? family.filter(({ phone }) => phone === state.triggered_by)
      : family;

    const contentVars = { "1": state.message || "A safety alert has been issued" };
    const results = await sendStaggered(
      recipients.map(({ phone }) =>
        () => sendTemplate(this.env, phone, this.env.TWILIO_TEMPLATE_SID, contentVars),
      ),
    );

    let delivered = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        delivered++;
      } else {
        console.error(`failed to send template to ${recipients[i].phone}:`, r.reason);
      }
    });

    // Confirm to the triggering admin.
    try {
      const prefix = state.test ? "🧪 TEST: " : "";
      const msgNote = state.message ? `\n📝 ${state.message}` : "";
      await sendText(
        this.env,
        state.triggered_by,
        `${prefix}Alert fired. Template delivered to ${delivered}/${recipients.length} family member${recipients.length === 1 ? "" : "s"}. ` +
          `I'll update you here as people check in.${msgNote}`,
      );
    } catch (err) {
      console.error("failed to notify admin after alarm fired:", err);
    }
  }

  // ---------- internals ----------

  private async broadcastBoard(state: IncidentState): Promise<void> {
    const family = await listOptedInFamily(this.env);
    const scopedFamily = state.test
      ? family.filter(({ phone: p }) => p === state.triggered_by)
      : family;
    const board = formatStatusBoard(state, scopedFamily);

    const openWindowRecipients = scopedFamily.filter(
      ({ phone: p }) => state.responses[p] || p === state.triggered_by,
    );

    const results = await sendStaggered(
      openWindowRecipients.map(({ phone: recipient }) =>
        () => sendBoard(this.env, recipient, board),
      ),
    );

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(
          `failed to send status board to ${openWindowRecipients[i].phone}:`,
          r.reason,
        );
      }
    });
  }

  private async loadState(): Promise<IncidentState | null> {
    return (await this.ctx.storage.get<IncidentState>("state")) ?? null;
  }

  private async saveState(state: IncidentState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }
}
