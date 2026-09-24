# AGENTS.md: nwc-lnd-bridge

Instructions for AI coding agents working on this repository.

## What This Project Is

A minimal NIP-47 (Nostr Wallet Connect) wallet service that fronts an LND
node. It listens for kind 23194 requests on a relay, proxies them to LND's
REST API, and publishes kind 23195 responses, with an invoice-only default
capability. It turns any LND node into a reusable NWC wallet for clients such
as `@forgesworn/nwc-kit`.

It is a single-file Node.js application (`nwc-bridge.mjs`), not a library:
there is no published package and no public API beyond the environment
variables and NIP-47 methods documented in the README.

## Commands

| Command | Purpose |
|---------|---------|
| `npm install` | Install dependencies |
| `npm start` | Run the bridge (`node nwc-bridge.mjs`) |
| `npm test` | Run the test suite (`node --test`) |
| `npm pack --dry-run` | Inspect the exact publish set (used in CI) |
| `npm audit` | Check for known dependency vulnerabilities (used in CI) |

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test`, `npm pack --dry-run`
and `npm audit` on Node 22 and 24.

## Structure

```
nwc-bridge.mjs       - the bridge: relay subscription, LND REST client, NIP-47 request handling
nwc-bridge.test.mjs  - tests against a fake LND, no running node or relay required
Dockerfile.nwc       - container build
docker-compose.yml   - compose file for running under Docker
.env.example         - template for the Docker .env file
```

## Conventions

- **British English** in prose and comments
- **Millisatoshis** for every LND and NIP-47 amount field (`MAX_PAY_MSAT`,
  `FEE_LIMIT_MSAT`, `value_msat`, `amt_msat`)
- Secrets (`keys.json`, the NWC URI) are written to `DATA_DIR` with mode
  `0600` and never logged; only the file path and a short pubkey fingerprint
  are logged
- `BRIDGE_SECRET` / `CLIENT_SECRET` env vars are deprecated in favour of
  `keys.json`; keep both paths working when touching key handling

## Common Pitfalls

- **Invoice-only is the default capability.** With `NWC_METHODS` unset the
  bridge serves only `make_invoice`, `lookup_invoice` and `get_info`. Do not
  widen the default allowlist; `pay_invoice` and `get_balance` are opt-in and
  `pay_invoice` refuses to start without both `MAX_PAY_MSAT` and
  `FEE_LIMIT_MSAT` set.
- **A missing preimage is never a success.** `pay_invoice` must throw
  `PAYMENT_FAILED` on a definite LND failure and a separate unknown-outcome
  error on a silent absence, never report success without a preimage.
- **Hashes and preimages are base64 in LND REST, hex in NIP-47.** Convert at
  the boundary; do not pass one format through unconverted.
- **`lookup_invoice` must set an explicit `state`.** Derive it from LND's
  invoice state rather than omitting it.
- **Expired requests (NIP-40 `expiration`) are dropped unanswered**, not
  answered late.
- **The bridge does not reconnect.** Losing every relay subscription exits the
  process with status 1 by design, so it can be restarted by a supervisor; do
  not add silent reconnect-and-continue behaviour without updating the README.
- **`list_transactions` (extension 05) is intentionally unimplemented.** A
  partial implementation would misrepresent the info event's advertised
  capabilities; `NWC_METHODS` refuses to start with a method the bridge does
  not implement.

## How to Verify a Change

Run `npm test` (a fake LND, no network needed) and, for anything touching
request handling, check behaviour against the method map and correctness
notes in the README before changing response shapes.
