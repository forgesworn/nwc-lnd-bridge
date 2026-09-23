# Changelog

## Unreleased

### Fixed

- Exit with status 1 when every relay subscription has closed. The bridge
  previously stayed up after a relay drop, deaf to every request, because
  nostr-tools does not reconnect by default. SIGTERM now shuts down cleanly.
- `pay_invoice` now needs `MAX_PAY_MSAT` and `FEE_LIMIT_MSAT`. The bridge asks
  LND to decode each invoice and refuses one above the cap with
  `QUOTA_EXCEEDED`, passes the fee ceiling to LND as `fee_limit`, and pays an
  amountless invoice only for an explicit, capped NIP-47 `amount`. It also
  reports `fees_paid`.
- Stop logging secrets. The URI and both keys were printed at every start and
  the README said to read them from `docker logs`. The keys now live in
  `DATA_DIR/keys.json` and the URI in `DATA_DIR/nwc-uri.txt`, both mode 0600,
  and only the file path and a wallet pubkey fingerprint are logged.
  `BRIDGE_SECRET`/`CLIENT_SECRET` still work when both are set but are
  deprecated; the README shows how to move them into `keys.json`.
- `make_invoice` honours `description_hash`, passing it to LND so the invoice
  commits to it. It was silently dropped.
- Drop requests whose NIP-40 `expiration` tag has passed, so a request delayed
  on a relay or replayed later cannot pay or mint after the client gave up.
- `.env.example` no longer sets `LND_REST_URL` to `127.0.0.1`, which inside
  the container is the container itself and overrode the compose default. Both
  now use `host.docker.internal`, which compose maps on Linux as well.
- Stop advertising `list_transactions` and extension `05`. The handler ignored
  `type`, `from`, `until`, `offset` and `unpaid` and did not cap `limit`, so it
  answered a different question from the one asked. It is removed from the
  default allowlist, and `NWC_METHODS` now refuses any method the bridge does
  not implement instead of advertising it.
- Accept only `wss://` relays, except `ws://` on loopback. The bridge refuses
  to start with a plaintext remote relay rather than dropping it silently.
- The Docker image installs from the lockfile with `npm ci --omit=dev` and runs
  as the unprivileged `node` user, which owns the `/data` directory.

## 0.1.0

First tagged version. Run from source or Docker; not published to npm.

- NIP-47 wallet service in front of an LND node over its REST API, NIP-44 v2
  only, serving one connection on one or more relays.
- Method allowlist that defaults to invoice-only (`make_invoice`,
  `lookup_invoice`, `list_transactions`, `get_info`). `pay_invoice` and
  `get_balance` are opt-in through `NWC_METHODS`.
- Refuses to start without LND's TLS certificate unless LND is on loopback or
  `LND_TLS_INSECURE=1` is set, since the macaroon travels in every request.
