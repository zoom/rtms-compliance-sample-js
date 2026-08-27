# rtms-compliance-sample-js — Specification

Backing sample for the [Real-Time Compliance Advisor in Meetings](https://github.com/zoom/blueprints/tree/main/blueprints/realtime-compliance-advisor) blueprint.

|                       |                                                                   |
| --------------------- | ----------------------------------------------------------------- |
| **Status**            | Implemented. 224 tests passing.                                   |
| **Complexity target** | Production-ready sample                                           |
| **Primary audience**  | Experienced developers at regulated firms                         |
| **ZfG compatible**    | Yes, via configurable `ZOOM_HOST`                                 |
| **Runtime**           | Node.js >= 22 (24 LTS recommended), `darwin-arm64` or `linux-x64` |

---

## Overview

A real-time compliance advisor for Zoom Meetings. The app receives live transcript segments through the [Zoom RTMS SDK](https://github.com/zoom/rtms), screens every segment against a versioned rule pack, and surfaces two things in an in-meeting panel visible only to the assigned representative: alerts for prohibited claims, and a checklist of required disclosures that marks each item satisfied when the representative actually says it. Every alert, verdict, disclosure change, and coverage gap is appended to a hash-chained audit log that a supervisor can verify after the call.

It exists because compliance review in regulated industries is retrospective. A surveillance team samples recordings weeks later, by which point the client has already acted on what they heard. Screening the transcript live moves the intervention point to inside the call, where the representative can still correct the record.

The app is deliberately opinionated in two ways. Screening is two-stage: a deterministic pattern pass runs on every segment, and only matches go to an LLM for context adjudication. And the audit log is append-only and hash-chained, so the evidence of supervision is tamper-evident rather than merely stored.

---

## Zoom Products Used

| Product                                                                                                        | Features demonstrated                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[RTMS](https://developers.zoom.us/docs/rtms/)** via [`@zoom/rtms`](https://www.npmjs.com/package/@zoom/rtms) | `Client.join`/`leave`; `onTranscriptData`; `setTranscriptParams` for explicit source language; `onParticipantEvent` for the attendee roster; `onActiveSpeakerEvent`; `onJoinConfirm`; `onLeave`; `onMediaConnectionInterrupted` for coverage gaps; `setProxy` for inspected egress |
| **[Zoom Apps](https://developers.zoom.us/docs/zoom-apps/)** (Surface App)                                      | In-meeting panel via the Zoom Apps SDK; `getMeetingUUID`, `getUserContext`, `getRunningContext`; in-client OAuth                                                                                                                                                                   |
| **[Webhooks](https://developers.zoom.us/docs/api/webhooks/)**                                                  | `meeting.rtms_started`, `meeting.rtms_stopped`, `endpoint.url_validation`; HMAC-SHA256 signature verification with a replay window                                                                                                                                                 |

Explicitly not used: Meeting SDK, Video SDK, Team Chat, Phone, Contact Center, Zoom REST meeting APIs beyond metadata.

---

## App Configuration

### App Type

**General App with a Zoom App (Surface) surface plus user-level OAuth.**

Justification: the panel runs inside the Zoom client, which requires the Zoom App type and the `zoomapp:inmeeting` scope. The app also needs to know _which_ participant is the assigned representative, because alert visibility is scoped to that person; leaking a compliance alert to the client on the call is itself a problem. That identity comes from the Zoom Apps SDK's `getUserContext()` in-client, which is why no REST scope is needed to obtain it.

Server-to-Server OAuth was considered and rejected. It authorizes at the account level with no per-user identity, so the app could not scope alert delivery, and the audit record could not attribute the dismissal of an alert to a specific representative.

The RTMS SDK authenticates with the same app's OAuth Client ID and Secret, supplied as `ZM_RTMS_CLIENT` and `ZM_RTMS_SECRET`.

### Required Scopes

| Scope               | Optional | Why it's needed                                                                |
| ------------------- | -------- | ------------------------------------------------------------------------------ |
| `zoomapp:inmeeting` | No       | Render the advisor panel inside a meeting. Without it there is no Surface App. |

**Exactly one scope.** Revised after implementation: an earlier draft also requested `meeting:read:meeting` and `user:read`, and neither was ever exercised. The app makes no server-side Zoom REST calls. Transcripts arrive over RTMS, the attendee roster arrives through `onParticipantEvent`, per-segment speaker identity arrives in the transcript callback's `metadata`, and panel identity comes from the Zoom Apps SDK in-client. Nothing is left for a REST scope to do.

The `zoom_app_apis` list was trimmed on the same principle: `getMeetingParticipants` was declared but contradicted the documented design, and `showNotification` and `onRunningContextChange` were never called.

A compliance application that over-requests permissions is a poor advertisement for itself, so the standing rule here is to add a scope in the same change that adds the call needing it.

### Webhook Events

| Event                     | Handling                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint.url_validation` | Answered before signature verification, since the challenge carries no signature. Responds with `plainToken` and its HMAC-SHA256 under the webhook secret. |
| `meeting.rtms_started`    | Verify signature, construct `rtms.Client`, register all callbacks, set transcript params, `join(payload)`.                                                 |
| `meeting.rtms_stopped`    | Verify signature, `leave()` the client for that `rtms_stream_id`, close the audit chain.                                                                   |

---

## Architecture

Single Node process running Express. The RTMS client runs in-process; there is no separate media microservice.

```
rtms-compliance-sample-js/
├── src/
│   ├── server.js              Express app, middleware, route mounting
│   ├── config.js              env parsing, fail-fast validation
│   ├── rtms/
│   │   ├── webhook.js         raw-body signature verification + routing
│   │   ├── session.js         stream Map, client lifecycle, callback wiring
│   │   └── segments.js        Buffer decode, normalize, seqNo assignment
│   ├── compliance/
│   │   ├── packs.js           YAML load, schema validate, compile, fail closed
│   │   ├── screen.js          deterministic pass, suppression window
│   │   ├── adjudicate.js      LLM call, JSON parse, timeout fallback
│   │   ├── disclosures.js     20s interval tracker, satisfied-only transitions
│   │   └── audit.js           canonical serialization, hash chain, verify
│   ├── api/
│   │   ├── routes.js          REST: meetings, audit export, dismissals
│   │   ├── ws.js              JWT-authed WebSocket broadcast
│   │   └── supervisor.js      outbound webhook on high severity
│   └── db/
│       ├── schema.prisma
│       └── client.js
├── web/                       React Surface App (Vite)
│   └── src/
│       ├── App.jsx
│       ├── useComplianceSocket.js
│       └── components/        AlertList, DisclosureChecklist, TranscriptView
├── rule-packs/
│   ├── fin-us-retail-v3.yaml
│   └── health-us-intake-v1.yaml
├── tests/
│   ├── unit/                  screen, audit, packs, segments, disclosures
│   └── integration/           webhook flow, ws auth, audit verify
├── .github/
│   ├── workflows/ci.yml
│   └── dependabot.yml
├── Dockerfile                 node:24-trixie-slim, multi-stage
├── compose.yaml               app + postgres
├── manifest.json              Zoom App manifest (mirrors the blueprint)
├── .env.example
├── README.md
├── CONTRIBUTING.md
├── LICENSE.md                 MIT
└── spec.md
```

### Data flow

1. Zoom POSTs `meeting.rtms_started` to `/api/rtms/webhook`.
2. `rtms/webhook.js` verifies `x-zm-signature` over the raw body, then hands off to `rtms/session.js`.
3. `session.js` creates an `rtms.Client`, calls `setTranscriptParams({ srcLanguage })`, registers every callback, then `join(payload)`. Callbacks must be registered before join or early segments are lost.
4. `onTranscriptData` fires per phrase. `segments.js` decodes the `Buffer`, assigns a monotonic `seqNo`, and normalizes speaker fields.
5. `screen.js` runs the compiled rule pack against the segment, inline. Target under 5ms. Clean segments broadcast and persist, and stop there.
6. Candidates go to `adjudicate.js`, which sends the candidate plus the prior 30 seconds to the LLM and parses a JSON verdict.
7. Verdicts broadcast over WebSocket to the assigned representative only, and append to the audit chain via `audit.js`.
8. `disclosures.js` runs every 20 seconds over the meeting's transcript and emits state changes.
9. `onMediaConnectionInterrupted` writes a coverage gap record. `onLeave` closes the chain.

### Key design decisions

- **Two-stage screening** keeps LLM cost proportional to risk and keeps stage one reproducible. An auditor can re-run a rule pack over a stored transcript and get identical matches; they cannot do that with a model verdict alone.
- **Rule packs are versioned artifacts, never edited in place.** The pack ID is pinned at session start and stamped on every audit record, so replaying an old meeting uses the rules in force at the time.
- **Fail closed on pack load.** An invalid or unparseable pack stops the process at startup. Screening with a partially loaded pack would produce an audit log that falsely implies full coverage.
- **The audit chain is separate from the transcript.** Different retention requirements, so different tables and different deletion paths.

---

## Credential Handling

- All credentials come from environment variables, loaded from `.env` in development via `node --env-file=.env`.
- `.env` is in `.gitignore` before the first commit. `.env.example` carries placeholders only, in the form `YOUR_CLIENT_ID_HERE`.
- `config.js` validates every required variable at startup and exits with a named error listing what is missing. No lazy failure at first webhook.
- The README states plainly that `.env` storage is not production-ready and recommends AWS Secrets Manager, HashiCorp Vault, or the platform equivalent.
- No credential is sent to the client bundle. The Surface App receives only a short-lived JWT scoped to one `meetingId`.
- No credential appears in logs. `ZM_RTMS_LOG_LEVEL=debug` is documented as safe for the SDK's own logs, and the app's logger redacts any key whose name matches `secret|token|key|password`.
- **No Zoom OAuth token is ever obtained or stored.** This was revised after implementation: the app makes no server-side Zoom API calls. Panel identity comes from the Zoom Apps SDK in-client, and the attendee roster comes from the RTMS `onParticipantEvent` callback rather than a REST call. An earlier draft of this spec required `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`; nothing read either, so both were removed. Requiring a secret no code consumes trains developers to generate values that do not matter, which devalues the one that does.
- **Exactly one signing secret, `JWT_SECRET`.** It signs the short-lived, meeting-scoped tokens the panel presents to the WebSocket and the audit API. It is the boundary that stops one meeting's panel from subscribing to another meeting's alerts.
- **Secrets this process both issues and verifies are generated outside production.** A missing `JWT_SECRET` is filled with 32 random bytes, and boot prints a warning naming what was generated. Credentials Zoom issues are never invented: a fabricated client secret trades a clear startup failure for a confusing 401 later. `NODE_ENV=production` generates nothing and defaults nothing.
- The webhook secret token (`ZM_RTMS_WEBHOOK_SECRET`) is used only for signature verification and never leaves the server.

---

## Zoom for Government

Required. Compliance tooling has an obvious federal and public-sector audience.

- `ZOOM_HOST` environment variable, defaulting to `https://zoom.us`.
- Derived hosts, all computed from `ZOOM_HOST` rather than hardcoded:

  | Commercial                    | Government                        |
  | ----------------------------- | --------------------------------- |
  | `https://zoom.us`             | `https://zoomgov.com`             |
  | `https://api.zoom.us`         | `https://api.zoomgov.com`         |
  | `https://marketplace.zoom.us` | `https://marketplace.zoomgov.com` |

- No `zoom.us` string appears outside `config.js`. A test asserts this.
- RTMS media endpoints are **not** configured by the app. They arrive in the webhook payload as `server_urls` and therefore follow the account's environment automatically. The README says this explicitly, because it is the question a ZfG customer asks first.
- README has a Zoom for Government section covering the env var and the `server_urls` behavior.

---

## Acceptance Criteria

### Webhook handling

1. When `endpoint.url_validation` arrives, the app responds 200 with `{ plainToken, encryptedToken }` where `encryptedToken` is HMAC-SHA256 of `plainToken` under `ZM_RTMS_WEBHOOK_SECRET`, and does so without attempting signature verification.
2. When a webhook arrives with a valid `x-zm-signature` computed over `v0:{timestamp}:{rawBody}`, the app processes it and responds 200.
3. When a webhook arrives with an invalid signature, the app responds 401 and does not create an RTMS client.
4. When a webhook arrives with an `x-zm-request-timestamp` more than 300 seconds from now, the app responds 401 and does not create an RTMS client.
5. Signature comparison uses `crypto.timingSafeEqual` and returns false on length mismatch before comparing.
6. Verification uses the raw request bytes, not a re-serialization of the parsed body.

### Stream lifecycle

7. On `meeting.rtms_started`, the app registers `onTranscriptData`, `onParticipantEvent`, `onJoinConfirm`, `onLeave`, and `onMediaConnectionInterrupted`, and calls `setTranscriptParams`, all before calling `join()`.
8. `setTranscriptParams` is called with an explicit `srcLanguage`, so transcription starts without the SDK's roughly 30-second language auto-detect.
9. A second `meeting.rtms_started` with an `rtms_stream_id` already in the session map is ignored; exactly one client exists for that stream ID.
10. When a `meeting.rtms_started` arrives with a new `rtms_stream_id` for a `meeting_uuid` that already has a session, the app calls `leave()` on the old client, removes it from the map, and joins the new stream.
11. On `meeting.rtms_stopped`, the app calls `leave()` for that stream ID, removes the map entry, and closes the audit chain.
12. When `onLeave` fires without a preceding `meeting.rtms_stopped`, the audit chain is still closed.
13. When `onMediaConnectionInterrupted` fires, a `coverage_gap` audit record is written with the callback timestamp.

### Segment handling

14. Transcript payloads are decoded with `buffer.toString('utf8')`; the callback's `Buffer` is never string-concatenated directly.
15. Callback timestamps are stored unchanged as Unix milliseconds; no microsecond rescaling is applied.
16. Each segment receives a monotonically increasing `seqNo` scoped to its stream, starting at 0.
17. A segment with missing `metadata.userId` or `metadata.userName` is stored with documented defaults rather than throwing.
18. Persistence uses upsert on `(meetingId, seqNo)`, so a replayed segment does not create a duplicate row.

### Rule packs and screening

19. On startup with an invalid rule pack (bad YAML, missing `id`, a rule without `severity`), the process exits non-zero with a message naming the file and the failing field. It does not start with partial rules.
20. Rule patterns compile once at load; screening a segment performs no regex compilation.
21. A segment matching two rules produces two candidates.
22. A segment matching no rule produces zero candidates and triggers no LLM call.
23. A second match of the same `ruleId` within 60 seconds of the first produces no new candidate; a match at 61 seconds does.
24. Screening a 200-character segment against the shipped `fin-us-retail-v3` pack completes in under 5ms.

### Adjudication

25. The LLM prompt includes the matched rule's `guidance` text.
26. A response wrapped in markdown fences parses successfully.
27. When the LLM returns malformed JSON, the alert is still emitted with `confidence: 0` and `adjudicated: false`, and is not silently dropped.
28. When the LLM call exceeds its timeout, behavior matches criterion 27.
29. Every emitted alert records `modelId` and `promptVersion`.
30. A `violation: false` verdict does not delete or overwrite the deterministic `ruleId` on the audit record.

### Disclosures

31. The disclosure tracker runs on a 20-second interval, not per segment.
32. A disclosure satisfied by the representative's speech transitions `pending` to `satisfied` and stores the satisfying quote and its `seqNo`.
33. A disclosure phrase spoken by a non-representative participant does not satisfy it.
34. A `satisfied` disclosure never returns to `pending`, even if later segments contradict it.

### Audit chain

35. The first record for a meeting has `prevHash` equal to 64 zero characters.
36. Each subsequent record's `prevHash` equals the previous record's `hash`.
37. `verifyChain(meetingId)` returns valid for an untampered chain.
38. Mutating any field of any stored record causes `verifyChain` to return invalid and to name the first bad record.
39. Deleting a record from the middle of the chain causes `verifyChain` to return invalid.
40. Canonical serialization uses a fixed key order; two records with identical values inserted in different key order hash identically.
41. A correction is a new appended record referencing the original ID; no `UPDATE` is issued against an audit row.
42. `GET /api/meetings/:id/audit` returns the chain plus a verification result as JSON.

### Alert delivery and authorization

43. A WebSocket connection without a valid JWT is closed with a 4401 close code.
44. A JWT scoped to meeting A cannot subscribe to meeting B.
45. `compliance.alert` messages are delivered only to the assigned representative and the host, never to other subscribers.
46. On reconnect, the client receives current alert and disclosure state before incremental updates resume.
47. Dismissing an alert writes an audit record attributing the dismissal to a user ID.
48. A high-severity alert triggers one POST to `SUPERVISOR_WEBHOOK_URL` when configured, and is a no-op when unset.

### Configuration and portability

49. Startup with any required environment variable missing exits non-zero and names every missing variable.
50. No string `zoom.us` exists in the source tree outside `src/config.js`.

### Developer setup ergonomics

55. Outside production, a missing `JWT_SECRET` is generated as 64 hex characters and reported on `config.generatedSecrets`.
56. A supplied `JWT_SECRET` is never overwritten, and `config.generatedSecrets` is empty.
57. Two consecutive loads with no `JWT_SECRET` produce different secrets.
58. In production, a missing `JWT_SECRET`, `DATABASE_URL`, or `PUBLIC_URL` exits non-zero. Nothing is generated and nothing is defaulted.
59. Only `JWT_SECRET` appears in `GENERATED_IN_DEV`. No Zoom-issued credential is ever generated, and a missing one fails in development exactly as it does in production.
60. `RULE_PACK_ID` has no default in any environment. `LLM_API_KEY` is optional in every environment, and the LLM client omits the authorization header entirely when it is absent.
61. `npm run env:init` writes a `.env` from `.env.example` with generated secrets substituted, at mode 0600, and refuses to overwrite an existing `.env` without `--force`. `npm run env:secrets` prints values and writes nothing.
62. In development, `DATABASE_URL` defaults to the compose Postgres and `PUBLIC_URL` defaults to `http://localhost:$PORT`. A supplied value always wins.
63. `docker build` succeeds and the resulting image starts and serves `GET /health`.
64. The Docker image uses a glibc base whose libstdc++ provides `GLIBCXX_3.4.31` or newer, and the `@zoom/rtms` native addon loads inside a booted container. Debian bookworm satisfies the glibc half and fails the second, so this must be verified by starting the container, not by inspecting the base image name.
65. `package.json` declares `"engines": { "node": ">=22.0.0" }` and `.nvmrc` pins 24.
66. Startup on Node 21 or lower exits with a readable version error before importing `@zoom/rtms`.

---

## Constraints — What NOT to Build

- **No audio or video processing.** Transcript only. `onAudioData`, `onVideoData`, and `onDeskshareData` stay unregistered.
- **No post-meeting recording analysis.** This is a live-screening sample. Retrospective batch review is a different architecture.
- **No real regulatory rule content.** The shipped packs are illustrative, clearly labeled as examples, and not a compliance product. No claim of FINRA, SEC, HIPAA, or FDCPA coverage.
- **No multi-tenancy.** One Zoom account per deployment. No org hierarchy, no per-tenant pack isolation.
- **No supervisor web console.** High-severity alerts go out via webhook and the audit log is available over the API. A reviewer UI is out of scope.
- **No archival integrations.** No connectors to Theta Lake, Smarsh, Global Relay, or S3. The JSON export is the integration point.
- **No horizontal scaling.** Single instance. Redis pub/sub and distributed session state are documented as production guidance, not implemented.
- **No custom model training or fine-tuning.** Prompted inference against a hosted model only.
- **No PII redaction or DLP.** Called out in the README as a real gap for production use.
- **No i18n in the panel.** English UI. `setTranscriptParams` accepts other source languages, and the README says so, but the shipped packs are English.

---

## Non-Production Disclosures

Every item here appears in a "Not production ready" section of the README.

| Simplification in this sample                                         | Production guidance                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `.env` file for credentials                                           | AWS Secrets Manager, HashiCorp Vault, or platform secret storage                             |
| Single-instance in-memory session `Map`                               | Redis, so a restart does not orphan joined streams or lose `seqNo` counters                  |
| Single-instance WebSocket broadcast                                   | Redis pub/sub fan-out across instances                                                       |
| Audit records in the same Postgres as app data                        | Separate database with WORM or object-lock backups, and a distinct credential                |
| Hash chain only, no external anchoring                                | Periodically publish chain heads to an append-only external store or timestamping authority  |
| Rule packs loaded from local disk                                     | Versioned artifact from a registry, with a compliance sign-off gate in CI                    |
| Synchronous LLM adjudication in the request path                      | Job queue with a bounded worker pool and backpressure                                        |
| Single LLM call with a fixed timeout, no retry                        | Exponential backoff with jitter, plus a circuit breaker                                      |
| No LLM provider rate-limit handling                                   | Detect 429, back off, and degrade to deterministic-only screening with a coverage-gap record |
| Supervisor webhook is fire-and-forget                                 | Durable outbox with retries and a dead-letter path                                           |
| No transcript retention policy enforcement                            | Scheduled deletion job aligned to your retention schedule, separate from the audit chain     |
| No PII or PHI redaction before LLM egress                             | Redact or tokenize before egress, or run inference in your own boundary                      |
| Prisma migrations applied at container start                          | Gated migration step in the deploy pipeline                                                  |
| Errors logged and swallowed at the callback boundary                  | Structured error reporting with alerting on screening-path failures                          |
| No authentication on the audit export endpoint beyond the meeting JWT | Role-based access control; auditors are not meeting participants                             |

---

## Testing Strategy

Node's built-in `node:test` runner. No extra framework, since the SDK already requires Node 22+.

### Unit

| Module                      | Focus                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rtms/webhook.js`           | Signature valid, invalid, missing, stale timestamp, length mismatch, url_validation bypass. Criteria 1-6.                                               |
| `rtms/segments.js`          | Buffer decode, timestamp passthrough, seqNo monotonicity, missing metadata defaults. Criteria 14-17.                                                    |
| `compliance/packs.js`       | Valid load, bad YAML, missing `id`, rule missing `severity`, compile-once assertion. Criteria 19-20.                                                    |
| `compliance/screen.js`      | Single match, multi match, no match, suppression window boundary at 60s and 61s, case and whitespace normalization, latency budget. Criteria 21-24.     |
| `compliance/adjudicate.js`  | Fenced JSON, malformed JSON, timeout, guidance present in prompt, modelId recorded. Criteria 25-30.                                                     |
| `compliance/disclosures.js` | Satisfaction by representative, non-satisfaction by client, no reverse transition, quote captured. Criteria 32-34.                                      |
| `compliance/audit.js`       | Genesis prevHash, chain linkage, tamper detection, deletion detection, key-order independence, append-only corrections. Criteria 35-41.                 |
| `config.js`                 | Missing var enumeration, ZOOM_HOST derivation for commercial and gov, dev secret generation and defaults, production strictness. Criteria 49-50, 55-62. |

### Integration

- Full webhook to alert path with the RTMS SDK faked at the module boundary: POST a signed `meeting.rtms_started`, drive synthetic transcript callbacks, assert an alert reaches a subscribed WebSocket client and an audit record lands. Criteria 7-13.
- Stream failover: same `meeting_uuid`, new `rtms_stream_id`, assert `leave()` on the old client. Criterion 10.
- WebSocket authorization: no JWT, wrong-meeting JWT, non-representative subscriber. Criteria 43-45.
- Audit export endpoint returns a chain plus verification result. Criterion 42.
- Repo hygiene: assert no `zoom.us` outside `config.js`, assert `engines.node`, assert `.env` is gitignored. Criteria 50, 53.

### Not covered by automated tests

Documented in the README rather than faked:

- A real RTMS join against live Zoom infrastructure. Requires an entitled account and a live meeting.
- Real LLM output quality. Adjudication tests use recorded fixtures; prompt quality is judged by hand.
- Rule pack accuracy against actual regulation. That is a compliance review, not a unit test.
- Native addon load on `linux-x64`. Covered by the Docker build job in CI, not by a unit test.

### Fake, not mock

`@zoom/rtms` is a native addon. Tests inject a fake client through a single factory in `rtms/session.js` rather than monkey-patching the module, so the addon is never loaded in unit tests. The Docker CI job is what proves the real addon loads.

---

## CI/CD and Dependency Management

### GitHub Actions (`.github/workflows/ci.yml`)

| Job       | Runs                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `test`    | Node 22 and 24 matrix on `ubuntu-latest`: `npm ci`, `npm test`, coverage summary                                                           |
| `lint`    | ESLint plus `prettier --check`                                                                                                             |
| `docker`  | `docker build`, start the container, assert `GET /health` returns 200. This is the gate that proves the native addon loads on `linux-x64`. |
| `secrets` | `gitleaks` scan on the diff                                                                                                                |
| `packs`   | Validate every file in `rule-packs/` against the pack schema                                                                               |

Triggers: pull requests to `main`, and pushes to `main`.

### Dependabot (`.github/dependabot.yml`)

Weekly checks for `npm` at the root and in `web/`, plus `github-actions` and `docker`. `@zoom/rtms` is grouped separately so an SDK bump is never bundled with unrelated updates.

---

## Next step

`/tools:test-first` to generate the test suite from the Acceptance Criteria above, before any implementation code is written.
