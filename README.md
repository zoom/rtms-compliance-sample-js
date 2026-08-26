# RTMS Compliance Advisor (Node.js sample)

Real-time compliance screening for Zoom Meetings, built on the [Zoom RTMS SDK](https://github.com/zoom/rtms).

Live transcript segments are screened against a versioned rule pack. Prohibited claims raise an alert in an in-meeting panel visible only to the assigned representative, required disclosures are tracked as a checklist, and every alert, verdict, and coverage gap is appended to a hash-chained audit log.

Reference implementation for the [Real-Time Compliance Advisor in Meetings](https://github.com/zoom/blueprints/tree/main/blueprints/realtime-compliance-advisor) blueprint.

> **This is a sample application, not a compliance product.** The shipped rule packs are illustrative examples and make no claim of FINRA, SEC, HIPAA, or FDCPA coverage. Read [Not production ready](#not-production-ready) before doing anything with it beyond evaluating the pattern.

---

## What it does

|                 |                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| **Screens**     | Every transcript segment against a compiled rule pack, under 5ms, no network call                         |
| **Adjudicates** | Only matched candidates go to an LLM, which judges context and drafts a correction                        |
| **Tracks**      | Required disclosures, marked satisfied only when the representative says them, with the quote as evidence |
| **Escalates**   | High-severity alerts POST to a supervisor webhook while the meeting is still live                         |
| **Records**     | An append-only, hash-chained audit log including gaps in coverage                                         |

### Why two stages

A regex hit is reproducible. An auditor can re-run a pinned pack version over a stored transcript and get byte-identical matches. A model verdict cannot be reproduced that way, so the two are stored in separate fields on every audit record and a reviewer can always tell which half was which.

The practical benefit is cost: clean segments never reach the LLM, so spend tracks risk rather than call volume.

---

## Requirements

| Requirement                            | Notes                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Node.js >= 22**                      | `@zoom/rtms` uses N-API 9/10. Node 24 LTS recommended. A lower version segfaults on import rather than failing cleanly. |
| **`darwin-arm64` or `linux-x64`**      | The platforms with prebuilt SDK binaries.                                                                               |
| **Paid Zoom Workplace plan with RTMS** | [Request RTMS access](https://www.zoom.com/en/realtime-media-streams/#form).                                            |
| **Docker**                             | Postgres locally, and the container build CI gates on.                                                                  |
| **ngrok or equivalent**                | A public HTTPS URL Zoom can deliver webhooks to.                                                                        |

---

## Quick start

```bash
git clone https://github.com/zoom/rtms-compliance-sample-js.git
cd rtms-compliance-sample-js
nvm use              # reads .nvmrc, pins Node 24
npm install
npm run env:init     # writes .env with secrets generated
```

Then fill in the four values only Zoom can give you: `ZM_RTMS_CLIENT`, `ZM_RTMS_SECRET`, `ZM_RTMS_WEBHOOK_SECRET`, and your `PUBLIC_URL`.

### What you do and do not have to configure

Outside production the app generates what only it cares about and defaults the local URLs, so the shortest working environment is four variables:

| Variable                           | Why it cannot be generated                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ZM_RTMS_CLIENT`, `ZM_RTMS_SECRET` | Issued by Zoom. A fabricated value trades a clear startup failure for a confusing 401 later.               |
| `ZM_RTMS_WEBHOOK_SECRET`           | Zoom signs webhooks with it. Both sides must agree.                                                        |
| `RULE_PACK_ID`                     | Which rules are in force is a compliance decision. This one has no default in any environment, on purpose. |

Everything else has a development answer:

| Variable       | Development behavior                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`   | Generated per boot, with a warning. Required in production.                                                                            |
| `DATABASE_URL` | Defaults to the compose Postgres. Required in production.                                                                              |
| `PUBLIC_URL`   | Defaults to `http://localhost:$PORT`. Required in production.                                                                          |
| `LLM_API_KEY`  | Optional everywhere. OpenRouter serves free models without one, and a failed adjudication still emits the alert, marked unadjudicated. |

`NODE_ENV=production` generates nothing and defaults nothing. It fails at boot with every missing variable named at once.

```bash
npm run env:secrets   # print generated secrets, write nothing
npm run env:init      # write .env at mode 0600; refuses to clobber an existing one
```

**What `JWT_SECRET` actually protects.** The panel gets `meetingUUID` and user context from the Zoom Apps SDK, posts them to `/api/panel/token`, and the server returns a short-lived token scoped to that one meeting. That signature is the only thing stopping one meeting's panel from subscribing to another meeting's compliance alerts. An ephemeral value is fine locally: after a restart the panel simply requests a new token.

<details>
<summary><strong>Full local setup</strong></summary>

1. **Start ngrok** with a [free static domain](https://dashboard.ngrok.com/domains):

   ```bash
   ngrok http 3000 --domain=your-subdomain.ngrok-free.app
   ```

2. **Create a Zoom App** at [marketplace.zoom.us](https://marketplace.zoom.us/): **Develop** > **Build App** > **General App**. Or upload [`manifest.json`](manifest.json) to skip the manual configuration.

   - OAuth Redirect URL: `https://YOUR-NGROK-URL/api/auth/callback`
   - Scopes: `zoomapp:inmeeting`, `meeting:read:meeting`, optionally `user:read`

   The redirect URL is required by the Marketplace form, but this sample never completes a token exchange and implements no `/api/auth/callback` route. It makes no server-side Zoom API calls: panel identity comes from the Zoom Apps SDK in-client, and the attendee roster comes from the RTMS `onParticipantEvent` callback. `meeting:read:meeting` and `user:read` are therefore declared but unused today; they are the scopes you would need the moment you add a REST call.
   - **Features** > **Zoom App SDK** > enable **Real-Time Media Streams** > select **Transcripts**
   - Surface: Home URL `https://YOUR-NGROK-URL`
   - Event Subscriptions: endpoint `https://YOUR-NGROK-URL/api/rtms/webhook`, events `meeting.rtms_started` and `meeting.rtms_stopped`

3. **Fill `.env`** with the Client ID, Client Secret, Webhook Secret Token, and your ngrok URL. `npm run env:init` already generated `JWT_SECRET`; nothing else needs generating.

4. **Start everything:**

   ```bash
   docker compose up --build
   ```

   Postgres on 5432, the app on 3000 (Express plus the RTMS client in one process), the panel dev server on 3001.

5. **Try it.** Join a meeting, open **Apps**, select your app, choose a rule pack, and start transcription. Say something the pack prohibits, like "we can offer a guaranteed return."

</details>

### Deploy

| Platform                                                                                             |                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------- |
| [Deploy to Render](https://render.com/deploy?repo=https://github.com/zoom/rtms-compliance-sample-js) | Backend, frontend, database |
| [Deploy to Railway](https://railway.app/new?repo=https://github.com/zoom/rtms-compliance-sample-js)  | Backend, frontend, database |

**Deploy anywhere:** the [Dockerfile](Dockerfile) is platform-agnostic. It must stay on a glibc base; Alpine's musl libc cannot load the RTMS native addon.

---

## Architecture

One Node process. The RTMS client runs in-process, so there is no separate media microservice to operate.

```
Zoom Meeting ──1. webhook──▶ Express + @zoom/rtms
     │                              │
     └──2. media WS────────────────▶│
                                    ├─3. segments──▶ Rule Engine (deterministic, <5ms)
                                    │                     │
                                    │                     └─4. candidates only──▶ LLM
                                    │                                              │
                                    │◀─────────────────5. verdicts─────────────────┘
                                    ├─6. WebSocket──▶ Advisor Panel (rep + host only)
                                    └─7. append────▶ Audit Log (hash-chained)
```

| Path                            | What lives there                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/config.js`                 | Environment parsing, fail-fast validation. **The only file allowed to contain a Zoom hostname.** |
| `src/rtms/webhook.js`           | HMAC verification, URL validation challenge, event routing. Pure functions.                      |
| `src/rtms/session.js`           | Client lifecycle, callback wiring, failover, coverage gaps                                       |
| `src/rtms/segments.js`          | Buffer decode, sequence numbering, speaker defaults                                              |
| `src/compliance/packs.js`       | YAML load, schema validation, pattern compilation. Fails closed.                                 |
| `src/compliance/screen.js`      | Deterministic pass and the suppression window                                                    |
| `src/compliance/adjudicate.js`  | Prompt construction, verdict parsing, timeout degradation                                        |
| `src/compliance/disclosures.js` | Checklist state machine                                                                          |
| `src/compliance/audit.js`       | Canonical serialization, hash chain, verification                                                |
| `src/api/ws.js`                 | Authenticated fan-out and the alert authorization rule                                           |
| `src/api/routes.js`             | Audit export                                                                                     |
| `rule-packs/`                   | Versioned YAML packs                                                                             |

### Details worth knowing if you are adapting this

**Register callbacks before `join()`.** Anything attached afterward misses the segments that arrived in between. On a regulated call the opening seconds carry the consent and disclosure language, so this is not a cosmetic bug.

**Set an explicit transcript language.** Without `setTranscriptParams({ srcLanguage })`, the SDK auto-detects, which takes roughly 30 seconds. That is 30 seconds of an unscreened regulated conversation. `TRANSCRIPT_LANGUAGE` in `.env` controls it.

**Record coverage gaps.** `onMediaConnectionInterrupted` fires when the media connection drops. An audit log that silently omits the gap implies the call was screened end to end, which is a stronger claim than the data supports.

**Timestamps are already Unix milliseconds.** Older RTMS examples divide by 1000 to convert from microseconds. Doing that here puts every segment in 1970.

**Deduplicate by `rtms_stream_id`, not `meeting_uuid`.** One meeting can produce several streams when a media server fails over.

---

## Rule packs

A rule pack is the contract between your compliance team and this code. Compliance owns the YAML; engineering owns the loader.

```yaml
id: fin-us-retail-v3 # version suffix required; never edit in place
jurisdiction: US
applies_to: [retail-investment-review]

prohibited:
  - id: guaranteed-return
    severity: high # high | medium | low
    match: ['guaranteed returns?', 'risk[- ]free']
    guidance: 'Past performance does not guarantee future results.'

required_disclosures:
  - id: fees-and-conflicts
    severity: high
    satisfied_by: ['advisory fee', 'conflict of interest']
    prompt: 'State the advisory fee schedule and any conflicts of interest.'
```

`match` and `satisfied_by` entries are case-insensitive regular expressions, compiled once at load.

Two shipped examples: `fin-us-retail-v3` and `health-us-intake-v1`. Both are illustrative.

Keep one pack per jurisdiction and meeting type rather than one pack with conditionals. Small packs are easier for a compliance reviewer to sign off on, and pinning a version per meeting stays meaningful.

```bash
npm run packs:validate
```

An invalid pack stops the service at startup rather than screening with partial rules.

---

## Zoom for Government

Set one variable:

```bash
ZOOM_HOST=https://zoomgov.com
```

API and Marketplace hosts derive from it (`api.zoomgov.com`, `marketplace.zoomgov.com`). No other change is required, and a test asserts no Zoom hostname is hardcoded anywhere outside `src/config.js`.

**RTMS media endpoints need no mapping.** They arrive in the webhook payload as `server_urls`, so they follow the account's environment automatically.

---

## Testing

```bash
npm test                 # 208 tests
npm run test:unit
npm run test:integration
```

Built test-first from [spec.md](spec.md); every acceptance criterion there maps to at least one test.

`@zoom/rtms` is faked at the client-factory boundary rather than mocked, because it is a native addon. The `docker` job in CI is the only place the real addon is loaded, which is what makes it a required gate.

**Not covered by automated tests**, deliberately:

- A real RTMS join against live Zoom infrastructure. Needs an entitled account and a live meeting.
- LLM output quality. Adjudication tests use fixtures; prompt quality is judged by hand.
- Rule pack accuracy against actual regulation. That is a compliance review, not a unit test.

---

## Not production ready

Everything below is simplified for a sample. None of it is hidden.

| Simplification here                              | What production needs                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `.env` file for credentials                      | AWS Secrets Manager, HashiCorp Vault, or platform secret storage                                  |
| Single-instance in-memory session map            | Redis, so a restart does not orphan joined streams or lose sequence counters                      |
| Single-instance WebSocket broadcast              | Redis pub/sub fan-out                                                                             |
| Audit records in the same Postgres as app data   | Separate database, distinct credential, WORM or object-lock backups                               |
| Hash chain with no external anchoring            | Publish chain heads periodically to an append-only external store or timestamping authority       |
| Rule packs from local disk                       | Versioned artifact from a registry, with a compliance sign-off gate in CI                         |
| Synchronous LLM adjudication in the request path | Job queue with a bounded worker pool and backpressure                                             |
| One LLM call, fixed timeout, no retry            | Exponential backoff with jitter, plus a circuit breaker                                           |
| No LLM rate-limit handling                       | Detect 429, back off, degrade to deterministic-only screening **and write a coverage-gap record** |
| Supervisor webhook is fire-and-forget            | Durable outbox with retries and a dead-letter path                                                |
| No transcript retention enforcement              | Scheduled deletion aligned to your retention schedule, separate from the audit chain              |
| No PII or PHI redaction before LLM egress        | Redact or tokenize before egress, or run inference inside your own boundary                       |
| Audit export authorized by the meeting JWT       | Role-based access control. Auditors are not meeting participants.                                 |
| Migrations applied at container start            | A gated migration step in the deploy pipeline                                                     |

**This is engineering guidance, not legal advice.** Rule pack content, retention periods, and supervision workflows must be reviewed and approved by your compliance and legal teams.

**Participant notice.** Participants see Zoom's standard transcription notice. Confirm with counsel whether your jurisdiction requires additional notice that live compliance screening is running.

**False positives are data.** Every alert a representative dismisses says something about pack quality. Dismissals are logged with the rule id; review them on the same cadence you review the packs.

---

## Related

- [Real-Time Compliance Advisor blueprint](https://github.com/zoom/blueprints/tree/main/blueprints/realtime-compliance-advisor)
- [zoom/rtms](https://github.com/zoom/rtms) - the SDK this is built on
- [RTMS SDK API reference](https://zoom.github.io/rtms/js/)
- [rtms-quickstart-js](https://github.com/zoom/rtms-quickstart-js) - smallest working RTMS app
- [RTMS documentation](https://developers.zoom.us/docs/rtms/)
- [Zoom Developer Forum](https://devforum.zoom.us/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE.md](LICENSE.md).
