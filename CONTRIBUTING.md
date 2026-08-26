# Contributing

Thanks for your interest. This is a sample application for the [Zoom developer platform](https://developers.zoom.us), maintained by Zoom Developer Advocacy.

## Before you start

This repo is a reference implementation for the [Real-Time Compliance Advisor blueprint](https://github.com/zoom/blueprints/tree/main/blueprints/realtime-compliance-advisor). Changes should keep the code readable as a teaching artifact. A clever optimization that makes the screening pipeline harder to follow is usually the wrong trade here.

## Requirements

| Requirement                       | Why                                                                       |
| --------------------------------- | ------------------------------------------------------------------------- |
| Node.js >= 22, 24 LTS recommended | `@zoom/rtms` uses N-API 9/10. Older versions segfault at import.          |
| `darwin-arm64` or `linux-x64`     | The only platforms with prebuilt SDK binaries.                            |
| Docker                            | Postgres for local development, and the container build the CI gate runs. |

## Setup

```bash
git clone https://github.com/zoom/rtms-compliance-sample-js.git
cd rtms-compliance-sample-js
nvm use          # reads .nvmrc
npm install
cp .env.example .env   # then fill in your values
```

## Tests

```bash
npm test                 # everything
npm run test:unit        # unit only
npm run test:integration # integration only
```

Tests use Node's built-in `node:test` runner. There is no external framework, because the SDK already requires Node 22+ and the runner ships with it.

**`@zoom/rtms` is faked, not mocked.** It is a native addon; loading it in unit tests would tie them to a platform binary and to Zoom infrastructure. `tests/helpers/fake-rtms.js` provides a fake injected through the client factory in `src/rtms/session.js`. The real addon is exercised by the `docker` job in CI, which is the only place that can prove it loads.

### Test-first, please

This project was built test-first from [spec.md](spec.md). Every acceptance criterion there maps to at least one test. If you are adding behavior:

1. Add or amend the acceptance criterion in `spec.md`
2. Write the failing test
3. Make it pass

If you are changing a test to make your code pass, stop and reconsider. Several tests encode compliance requirements rather than implementation preferences, notably:

- Alerts reach only the representative and the host
- A satisfied disclosure never reverts to pending
- Rule pack loading fails closed
- Audit records are append-only and hash-linked
- Clean transcript segments never reach the LLM

## Rule packs

Rule packs in `rule-packs/` are **illustrative examples, not compliance products**. If you contribute one:

- Keep the "example only, not legal advice" header
- Give the pack id a version suffix and never edit a published pack in place
- Every rule needs an `id`, a `severity`, and `guidance` a representative can actually say out loud

Validate before opening a PR:

```bash
npm run packs:validate
```

## Code style

```bash
npm run lint        # check
npm run lint:fix    # fix what is fixable
```

Two rules the linter cannot catch:

1. **No Zoom hostname outside `src/config.js`.** Everything reads `config.apiHost` so that a Zoom for Government deployment is one environment variable. A test enforces this.
2. **No credentials in logs.** Secrets are attached to the config object non-enumerably so `JSON.stringify(config)` cannot leak them. Keep it that way.

## Dependency pins worth knowing about

`package.json` carries one `overrides` entry:

```json
"overrides": { "deepmerge-ts": "^8.0.0" }
```

The Prisma CLI depends on `deepmerge-ts` 7.x, which has a stack-exhaustion advisory ([GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)). The override forces 8.x and brings `npm audit` to zero. Remove it once Prisma ships a release that depends on 8.x directly.

Prisma is intentionally held at 6.x. Prisma 7 moves the datasource URL into a `prisma.config.ts` and requires a driver adapter, which is a meaningful amount of plumbing for a sample whose subject is RTMS rather than ORM configuration.

## Never commit credentials

`.env` is gitignored. `.env.example` carries placeholders only, in the form `YOUR_VALUE_HERE`. CI runs a secret scan on every PR, and Zoom's push-time scanner also matches key-shaped strings, so even a realistic-looking fake key will be rejected.

## Pull requests

1. Branch from `main`
2. Make sure `npm test` and `npm run lint` pass
3. Describe what changed and why; link the blueprint section if the change affects documented behavior
4. If you changed behavior the blueprint describes, say so. The blueprint and this repo have to stay in agreement.

## Security

Do not open a public issue for a security problem. Follow Zoom's [vulnerability disclosure process](https://zoom.us/trust/security).

## Questions

[Zoom Developer Forum](https://devforum.zoom.us/) is the best place. For questions about the RTMS SDK itself, use the [zoom/rtms](https://github.com/zoom/rtms) repository.
