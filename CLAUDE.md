# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — local development via `wrangler dev`
- `npm run typecheck` — strict TypeScript check (`tsc --noEmit`); there is no test suite
- `npm run deploy` — `wrangler deploy` to Cloudflare
- `npx wrangler secret put <NAME>` — set secrets listed in `wrangler.jsonc` (`ADMIN_PIN`, `TWILIO_*`, optional `MAX_ALERTS_PER_MONTH`)
- `npx wrangler kv namespace create <NAME>` — create the four KV namespaces (`FAMILY`, `RATE_LIMIT`, `RECENT_INCIDENTS`, `AUTH_FAIL_COUNTS`); paste the returned ids into `wrangler.jsonc` placeholders
- Seed/manage family members directly via `npx wrangler kv key put --binding=FAMILY "+E164" '{"name":"...","is_admin":true,"joined_at":0}'`
- Clear an admin lockout: `npx wrangler kv key delete --binding=AUTH_FAIL_COUNTS "lock:+E164"`

## Architecture

This is a single Cloudflare Worker that acts as a Twilio WhatsApp webhook for a family safety check-in bot. All control flow is driven by inbound WhatsApp messages — there is no UI, no database server, and no background scheduler other than a Durable Object alarm.

**Request path** (`src/worker.ts`): every POST `/webhook` is HMAC-SHA1 signature-verified against `TWILIO_AUTH_TOKEN` *before* any state is touched. The `From` is normalized (Twilio inconsistently strips the `whatsapp:` prefix). After verification, `route()` looks up the sender in the `FAMILY` KV and dispatches:
- Button taps (`ButtonPayload` set) → `handleFamilyMessage` regardless of admin status.
- Free-text from admins → `handleAdminCommand` (`src/commands.ts`).
- Free-text from regular members → `handleFamilyMessage` (matches `safe` / `help` patterns during an active incident).
- Unknown senders → `unknownSenderReply`.

Replies are sent out-of-band via the Twilio REST API (`sendText`/`sendTemplate` in `src/twilio.ts`), not via TwiML, so the webhook always returns `200` — even on internal errors — to prevent Twilio retry storms from re-processing partially-handled messages.

**Incident lifecycle** is the central piece and lives in the `Incident` Durable Object (`src/incident.ts`). One DO instance per incident provides strong consistency for concurrent check-ins.
1. `queueAlert` persists initial state and sets a Cloudflare alarm `CANCEL_WINDOW_MS` (10s) in the future. The alarm is used instead of `setTimeout` because it survives Worker cold starts.
2. `cancel` deletes the alarm if the incident hasn't fired yet.
3. The `alarm()` callback marks `fired = true`, fans out the approved Twilio template (`TWILIO_TEMPLATE_SID`) to every enrolled member except the triggering admin, and DMs the admin a delivery summary.
4. `recordResponse` is called from the check-in path. It dedupes by Twilio `MessageSid` (Twilio retries 5xx → must be idempotent), enforces "first response wins" so people can't flip between safe/help, and rebroadcasts the status board.

**Status board fanout** is cost-controlled by the WhatsApp 24-hour service window. After every check-in, only family members whose window is provably open get the updated board: anyone who has already responded to *this* incident, plus the admin who triggered it. Members who haven't tapped yet see the board only when they themselves tap. `sendOrEditBoard` (`src/statusBoard.ts`) edits the previous board message in place when within WhatsApp's 15-minute edit window, otherwise sends a fresh message; the per-recipient `StatusBoardRef` lives inside `IncidentState.status_board_sids`.

**State storage layout**:
- `FAMILY` KV — per-phone roster entries (`{name, is_admin, joined_at}`), key is the E.164 phone with `+`.
- `RATE_LIMIT` KV — 5-minute inter-alert lockout (overridable with `alert <pin> force`).
- `RECENT_INCIDENTS` KV — pointer to the most recent incident id, used by `status` lookup.
- `AUTH_FAIL_COUNTS` KV — sliding-window PIN-failure counters and 24-hour lockout markers.
- `Incident` DO storage — the only strongly-consistent store. Holds full `IncidentState` (responses, processed webhook sids, alarm flags, status-board sids).

**Phone format invariant**: everywhere in code, `Phone` is E.164 with a leading `+` and no `whatsapp:` prefix. Twilio's `whatsapp:` prefix is stripped on inbound and re-added only inside `src/twilio.ts` when calling the REST API. Don't propagate the prefixed form into KV keys, DO state, or `IncidentState.responses`.

**Security guarantees worth preserving when editing**:
- Never read request body fields before signature verification.
- Always return 200 from `/webhook` (Twilio retries on 5xx).
- Webhook handlers must remain idempotent per `MessageSid`.
- Admin PIN gating, fail-window counters, and the 24-hour lockout all live in `commands.ts` + `AUTH_FAIL_COUNTS`; don't bypass them when adding new admin actions.
