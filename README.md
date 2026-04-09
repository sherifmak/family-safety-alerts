# family-safety-alerts

A WhatsApp-based "I'm safe" check-in bot for your family.

When something happens — an escalation, an outage, a natural disaster — an admin texts `alert <pin>` to the bot from WhatsApp. Ten seconds later, every enrolled family member's phone buzzes with a normal WhatsApp notification carrying two buttons: **I'M SAFE** and **NEED HELP**. As people tap, a live status board appears in their chat — everyone sees, in real time, who has checked in and who hasn't. Nothing new to install, no app switch, one tap per person.

This is a GitHub Template. Click **"Use this template"** at the top of the repo to create your own copy, then follow the setup guide below.

## What's in the box

- `src/worker.ts` — Cloudflare Worker entrypoint, verifies the Twilio webhook signature and routes messages.
- `src/commands.ts` — admin command parser (`alert`, `status`, `enroll`, `list`, `cancel`, `help`, `remove`).
- `src/checkin.ts` — handles family button taps and "safe"/"help" free-text replies.
- `src/incident.ts` — `Incident` Durable Object: strong-consistent per-incident state, 10-second cancel-window alarm, webhook dedupe, status-board fanout, stale-incident guard.
- `src/statusBoard.ts` — formats the live status board.
- `src/twilio.ts` — thin Twilio WhatsApp client and HMAC-SHA1 signature verifier.
- `src/kv.ts` — Cloudflare KV helpers for family roster, rate limits, and PIN lockouts.

## Prerequisites

- A Cloudflare account (free tier is sufficient).
- A Twilio account (new accounts get $15 of free credit, enough for initial testing).
- `node` 18+ and `npm`.
- At least one phone you can test with. Two or three is better.

## Setup

### 1. Install and configure Cloudflare

```bash
npm install
npx wrangler login
```

Create the KV namespaces:

```bash
npx wrangler kv namespace create FAMILY
npx wrangler kv namespace create RATE_LIMIT
npx wrangler kv namespace create RECENT_INCIDENTS
npx wrangler kv namespace create AUTH_FAIL_COUNTS
```

Each command prints an `id` string. Paste those into `wrangler.jsonc`, replacing the `REPLACE_WITH_..._KV_ID` placeholders.

### 2. Sign up for Twilio and activate the WhatsApp sandbox

1. Create a Twilio account at [twilio.com](https://www.twilio.com/).
2. In the Twilio Console, navigate to **Messaging → Try it out → Send a WhatsApp message**.
3. Follow the sandbox instructions: WhatsApp a join code (e.g., `join abc-def`) to the sandbox number from every phone you want to test with. The sandbox connection expires every 72 hours during development but works instantly without any template approval — perfect for initial testing.
4. Copy your **Account SID**, **Auth Token**, and the sandbox **From** number (e.g., `whatsapp:+14155238886`).

### 3. Set Worker secrets

```bash
npx wrangler secret put ADMIN_PIN           # e.g. a 4-6 digit number you'll remember
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM         # e.g. whatsapp:+14155238886
npx wrangler secret put TWILIO_TEMPLATE_SID # placeholder for sandbox; real value after approval
# Optional:
npx wrangler secret put MAX_ALERTS_PER_MONTH   # e.g. 20 (hard cost cap)
```

For sandbox testing, `TWILIO_TEMPLATE_SID` can be set to any placeholder — the single-phone admin loop and cancel window can be verified without ever sending a template.

### 4. Seed your admin phone number

Write your own phone number (in full E.164 format with a leading `+`, no spaces or dashes) into the `FAMILY` KV with admin privileges — this is the only thing you have to do from the terminal; everything else is done via WhatsApp.

```bash
npx wrangler kv key put \
  --binding=FAMILY \
  "+1234567890" \
  '{"name":"Admin","is_admin":true,"joined_at":0}'
```

Replace `+1234567890` with your actual phone number in E.164 format.

Add at least **one additional admin with a backup phone** — ideally in a different country or on a different carrier. If your primary phone dies or loses signal during a crisis, the backup admin can still fire an alert.

### 5. Deploy the Worker and point Twilio at it

```bash
npx wrangler deploy
```

Wrangler prints a URL like `https://family-safety-alerts.<your-subdomain>.workers.dev`. In the Twilio Console → **Messaging → Settings → WhatsApp Sandbox Settings**, set the "When a message comes in" webhook to:

```
https://family-safety-alerts.<your-subdomain>.workers.dev/webhook
```

with method **HTTP POST**.

### 6. Sandbox test

From your admin WhatsApp (the phone whose number you seeded in step 4):

```
hi                  → lists admin commands (you're an admin, so the welcome reply is the command list)
help                → lists admin commands
enroll +1234567890 TestPerson
list                → shows enrolled members
alert 1234          → queues an alert (replace 1234 with your ADMIN_PIN)
cancel              → aborts it within the 10-second window
```

Once you've verified the admin loop, enroll a second phone, fire an alert, tap the button on the second phone, and verify the status board appears in both chats.

### 7. Move to production (after sandbox works)

1. In Twilio, request a production WhatsApp sender (buy a phone number and attach it to a Meta Business Account).
2. Using **Twilio Content Template Builder**, create a `UTILITY` category quick-reply template with a body like:

   > ⚠️ An escalation has been reported. If you're safe, tap I'M SAFE below. If you need help, tap NEED HELP.

   and two quick-reply buttons:
   - **I'M SAFE** with button ID (payload) `SAFE`
   - **NEED HELP** with button ID (payload) `HELP`

   The button IDs **must** be exactly `SAFE` and `HELP` — the check-in handler in `src/checkin.ts` pattern-matches on them.

3. Submit the template for Meta approval. Expect anywhere from a few minutes to 1-3 days. Utility safety templates are routinely approved; if rejected, tighten the wording to remove anything that could read as marketing.
4. Once approved, Twilio gives you a Content SID starting with `HX...`. Update the production secrets:

   ```bash
   npx wrangler secret put TWILIO_FROM        # new whatsapp:+<your-production-number>
   npx wrangler secret put TWILIO_TEMPLATE_SID # the HX... SID
   ```

5. Point the production sender's webhook at `/webhook` the same way you did for the sandbox (Messaging → Senders → WhatsApp senders → your sender → webhook config).

### 8. Enroll the family

Share the production bot number and ask each family member to save it as a contact and send a `hi` message (this gives explicit opt-in AND opens their 24-hour WhatsApp service window so the bot can reach them with free-text status updates). For each person, run from your admin WhatsApp:

```
enroll +1234567890 Alice
enroll +1234567891 Bob
...
```

Run a final test alert. **Warn the family first** so they know it's a drill.

## Usage (from an admin's WhatsApp)

| Command | What it does |
|---|---|
| `alert <pin>` | Fires an alert to every enrolled family member after a 10-second cancel window. |
| `alert <pin> force` | Same, but skips the 5-minute rate limit. |
| `cancel` | Aborts a pending alert within the 10-second window. |
| `status` | Shows the current check-in status for the most recent incident (within the last 2 hours). |
| `list` | Lists all enrolled family members. |
| `enroll <phone> <name>` | Adds a family member (phone must be E.164 with `+`). |
| `remove <phone>` | Removes a non-admin family member. |
| `help` | Shows the command list. |

## How it stays safe

- **Twilio signature verification** on every inbound webhook (HMAC-SHA1 over the full URL + sorted params). Unsigned or invalid requests get 401. Verification runs before any state is touched.
- **Admin PIN** required for `alert`. 3 failed attempts → 24-hour lockout for that sender. Bad PINs return "Unknown command" rather than "Invalid PIN" to avoid revealing which commands exist to non-admins.
- **10-second cancel window** on every alert, implemented with a Durable Object alarm (survives Worker cold starts, unlike `setTimeout`).
- **5-minute rate limit** between alerts to prevent double-taps during panic. Admin can override with `force`.
- **Optional monthly cap** (`MAX_ALERTS_PER_MONTH`) bounds worst-case cost.
- **Webhook dedupe** by Twilio `MessageSid` inside the Incident DO — retried webhooks don't double-count button taps.
- **Strong consistency** on incident state via Durable Objects. Concurrent check-ins can't corrupt the status board.
- **Stale-incident guard**: an incident older than 2 hours is automatically treated as closed, so casual family messages don't accidentally trigger ghost status-board broadcasts long after a real alert is over.

## Cost

Roughly **$3-8/month** in a normal month for a family of 15:

- Cloudflare Workers + KV + Durable Objects: free tier, $0.
- Twilio WhatsApp-enabled number: ~$1-5/month.
- Meta utility template send: ~$0.015-$0.025 per recipient (varies by country; only billed for the initial alert — status-board updates inside the 24-hour window are free).
- Twilio platform fee: $0.005 per message sent or received.

Twilio's $15 new-account credit typically covers the first month end to end.

## Accepted limitations

- **The bot cannot post into your existing family WhatsApp group.** The official WhatsApp Business API deliberately does not support group messaging. Each family member instead gets a 1:1 thread with the bot that shows the same live status board.
- **Family members with closed 24-hour windows** (people who've never texted the bot recently) only get the initial template — they don't receive follow-up status updates until they tap a button themselves. This is a cost control, not a limitation.
- **Admin PINs are visible in plaintext** to Twilio and Cloudflare server operators. Acceptable for a family tool; not acceptable for a high-threat environment.

## Customization

The codebase is deliberately minimal and un-parameterized — common customizations are done by editing a few specific lines in source. No env vars, no config files.

### Timezone

The status board and the `status` command format timestamps in `Asia/Beirut` by default (the origin region). Change it in two places:

- `src/statusBoard.ts:7` — inside `beirutTime()`, replace `"Asia/Beirut"` with your IANA timezone (e.g., `"America/New_York"`, `"Europe/London"`, `"Asia/Tokyo"`). The function name itself can stay as a historical artifact or you can rename it.
- `src/commands.ts:132` — inside `statusCommand`, same replacement.

Use any IANA timezone string from the [tz database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

### Check-in language patterns

`src/checkin.ts` has two regex patterns that match "safe" and "help" free-text responses so family members can reply with typed words instead of tapping a button:

- `SAFE_PATTERN` at `src/checkin.ts:7` — covers English (`safe`, `ok`, `okay`, `fine`, `alright`...) plus Arabic transliterations from the original deployment (`salim`, `salem`, `bkhair`...).
- `HELP_PATTERN` at `src/checkin.ts:8` — covers English (`help`, `sos`, `emergency`, `trapped`, `injured`...).

Edit the alternation lists to add words and transliterations your family would actually use. The patterns are case-insensitive and use word boundaries, so they're safe to extend.

### Tunable constants

- `CANCEL_WINDOW_MS` (default `10_000` / 10s) at `src/incident.ts:7` — how long the admin has to `cancel` before the alarm fires. Be careful shortening this; 10 seconds is already tight for "oh wait, wrong button".
- `RATE_LIMIT_MS` (default `300_000` / 5 min) at `src/commands.ts:20` — minimum gap between two alerts. Override per-alert with `alert <pin> force`.
- `MAX_AUTH_FAILS` (default `3`) at `src/commands.ts:21` — how many wrong-PIN attempts before a 24-hour lockout.
- `INCIDENT_ACTIVE_WINDOW_MS` (default `2 * 60 * 60_000` / 2 hours) at `src/incident.ts:13` — incidents older than this are treated as closed even if the RECENT_INCIDENTS pointer still references them. Prevents ghost status boards.

### Alert template wording

The initial alert message is set in the Twilio Content Template you create in step 7 of the setup guide — not in this repo. Edit it in the Twilio Content Template Builder, resubmit for Meta approval if needed.

## Troubleshooting

**"invalid signature" 401s on /webhook**
→ The Twilio Auth Token you set as a secret doesn't match the one Twilio is signing with. Double-check with `npx wrangler secret put TWILIO_AUTH_TOKEN`.

**Alert fires but nobody receives the template**
→ In the sandbox, each recipient must have joined the sandbox with the `join <code>` message (and rejoined within the last 72 hours). In production, Meta template approval is required before templates can be sent.

**Status board doesn't update after the first check-in**
→ The recipient's 24-hour WhatsApp service window needs to be open. If they haven't sent the bot a message recently (e.g., the "hi" during enrollment was over 24h ago), status updates to them are suppressed.

**"Too many failed attempts. You are locked out for 24 hours."**
→ Clear the lockout with `npx wrangler kv key delete --binding=AUTH_FAIL_COUNTS "lock:+<your-admin-phone-in-e164>"`.

**You want to rotate the admin PIN**
→ `npx wrangler secret put ADMIN_PIN` — takes effect on the next request, no redeploy needed.

**After a test alert, new family members get ghost status boards when they send `hi`**
→ Should be automatically prevented by the stale-incident guard (incidents older than 2 hours are treated as closed). If you hit this inside the 2-hour window, clear manually: `npx wrangler kv key delete --binding=RECENT_INCIDENTS --remote "open"`.

## Credits

Originally built by [Sherif Maktabi](https://github.com/sherifmak) for his family in Lebanon during a period of regional instability. Open-sourced as a GitHub Template so others can adapt it for their own families, wherever they are.

If you deploy this for your family and it saves you one phone-tree round-trip during a real event, it was worth building.

## License

MIT — see [LICENSE](./LICENSE).
