# nwc-lnd-bridge

A minimal NIP-47 (Nostr Wallet Connect) wallet service in front of an LND node.
It listens for kind 23194 requests on a relay, proxies them to LND's REST API,
and publishes kind 23195 responses. On startup it writes a
`nostr+walletconnect://` URI to an owner-only file.

It turns any LND, including a mint's node, into a reusable NWC wallet for
clients like [`@forgesworn/nwc-kit`](https://github.com/forgesworn/nwc-kit)
and the merchant backend in
[`toll-booth`](https://github.com/forgesworn/toll-booth).

## The URI is a capability. Scope it.

The URI is a spending-and-query capability over the node it fronts. Treat it,
and the `keys.json` it is derived from, like a password. The bridge never
prints either: it writes them to `DATA_DIR` with mode 0600 and logs only the
file path and a short fingerprint of the wallet pubkey. Two independent guards
keep it safe to point at a funds-holding node:

1. **Method allowlist, invoice-only by default.** With `NWC_METHODS` unset the
   bridge serves only `make_invoice`, `lookup_invoice` and `get_info`. It advertises exactly that set in its kind 13194 info event and
   refuses anything else before the request reaches LND, so the URI **cannot
   spend or disclose a balance**. `pay_invoice` and `get_balance` are opt-in.
2. **An invoice-only macaroon.** Independently of the allowlist, authenticate
   with a baked macaroon that only permits invoice operations:

   ```sh
   lncli bakemacaroon \
     invoices:read invoices:write info:read \
     --save_to invoice.macaroon
   ```

   Then the node itself rejects a spend even if the allowlist were widened by
   mistake. Belt and braces.

To deliberately run a full wallet (own funds, not a mint), list the methods
and set both spend limits. The bridge refuses to start with `pay_invoice`
enabled unless both are set:

```sh
NWC_METHODS="make_invoice lookup_invoice pay_invoice get_balance get_info"
MAX_PAY_MSAT=100000    # largest single payment, in millisatoshis
FEE_LIMIT_MSAT=2000    # most routing fee LND may spend on one payment
```

### What the spend limits cover

These are the only limits the bridge enforces. There is no daily or total
budget, no rate limit and no per-destination rule. Anyone holding the URI can
make as many payments as they like, each up to `MAX_PAY_MSAT` plus up to
`FEE_LIMIT_MSAT` in fees, until the node runs out of funds. For a real budget,
fund the node (or a dedicated LND account) with no more than you are willing to
lose through the URI.

- **`MAX_PAY_MSAT`** caps the amount of each payment. The bridge asks LND to
  decode the invoice and refuses anything above the cap with `QUOTA_EXCEEDED`
  before paying. For an amountless invoice the NIP-47 `amount` is used, capped
  the same way, and passed to LND as `amt_msat`; an amountless invoice with no
  `amount` is refused. An `amount` that contradicts the invoice is refused.
- **`FEE_LIMIT_MSAT`** is passed to LND on every payment as
  `fee_limit.fixed_msat`, so a route costing more than that is not taken.

With `pay_invoice` enabled the macaroon needs `offchain:read` (to decode the
invoice) and `offchain:write` (to pay it).

## Run

Node 22+ directly:

```sh
npm install
LND_REST_URL=https://127.0.0.1:8080 \
LND_MACAROON=$(xxd -p -c 2000 invoice.macaroon | tr -d '\n') \
LND_CERT_PATH=/path/to/tls.cert \
RELAY=wss://relay.damus.io \
npm start
cat data/nwc-uri.txt
```

Or Docker (see `docker-compose.yml`, copy `.env.example` to `.env` first):

```sh
docker compose up -d --build
docker compose exec nwc-lnd-bridge cat /data/nwc-uri.txt
```

On first run the bridge generates its keys and saves them in
`DATA_DIR/keys.json`, so the URI stays the same across restarts. Under Docker
`DATA_DIR` is the `nwc-data` volume. To revoke the URI, stop the bridge, move
`keys.json` out of the data directory and start it again.

`BRIDGE_SECRET` and `CLIENT_SECRET` are still read if both are set, for
deployments that already pin them, but they are deprecated. To move an existing
URI to the data directory, write the two values into `keys.json` as
`{"bridge_secret": "…", "client_secret": "…"}` with mode 0600, then remove them
from the environment.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LND_REST_URL` | `https://127.0.0.1:8080` | LND REST endpoint |
| `LND_MACAROON` | (required) | Hex-encoded macaroon; invoice-only for a funds node |
| `LND_CERT_PATH` / `LND_CERT` | none | LND `tls.cert` (path, or inline PEM / base64). Required unless LND is on loopback |
| `LND_TLS_INSECURE` | unset | `1` skips TLS verification for a non-loopback LND without a cert. The macaroon crosses that link in every request, so only on a network you trust |
| `RELAY` | `wss://relay.damus.io` | Relay(s) to serve NWC on. One URL, or several separated by spaces or commas, for resilience. `wss://` only; `ws://` is accepted on loopback |
| `NWC_METHODS` | invoice-only set | Space-separated method allowlist from `make_invoice lookup_invoice get_info get_balance pay_invoice` |
| `MAX_PAY_MSAT` | none | Per-payment cap in msat. Required when `pay_invoice` is enabled |
| `FEE_LIMIT_MSAT` | none | Routing fee ceiling per payment in msat. Required when `pay_invoice` is enabled |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where `keys.json` and `nwc-uri.txt` are written, both mode 0600 |
| `BRIDGE_SECRET` / `CLIENT_SECRET` | unset | Deprecated. Hex 32-byte keys; used instead of `keys.json` only when both are set |

## Method map

| NIP-47 method | LND REST |
| --- | --- |
| `make_invoice` | `POST /v1/invoices` (`value_msat`, `description_hash`) |
| `lookup_invoice` | `GET /v1/invoice/{payment_hash}` |
| `get_info` | `GET /v1/getinfo` |
| `get_balance` (opt-in) | `GET /v1/balance/channels` (local/spendable) |
| `pay_invoice` (opt-in) | `GET /v1/payreq/{invoice}`, then `POST /v1/channels/transactions` (`fee_limit`, `amt_msat` for amountless) |

## Correctness notes

These are the traps a NIP-47 bridge falls into. Each is handled and tested.

- **`pay_invoice` never reports a missing preimage as success.** LND signals a
  routing failure with `payment_error` and no preimage. The preimage is the only
  proof of settlement, so a definite failure throws `PAYMENT_FAILED` and a silent
  absence throws an unknown-outcome error to reconcile, never a fake success.
- **`lookup_invoice` sets an explicit `state`.** A NIP-47 client keys settlement
  off `state`; leaving it out reads as unsettled even with a preimage present, so
  it is derived from LND's invoice state.
- **Hashes and preimages are converted base64 to hex.** LND REST returns them
  base64; NWC expects hex.
- **Expired requests are ignored.** A request whose NIP-40 `expiration` has
  passed is dropped unanswered, so a delayed or replayed request cannot pay or
  mint after the client stopped waiting.
- **Losing every relay stops the process.** The bridge does not reconnect. When
  the last relay subscription closes it exits with status 1, so run it under a
  supervisor that restarts it (the compose file uses `restart: unless-stopped`;
  under systemd use `Restart=on-failure`). A restart reconnects, re-subscribes
  and republishes the info event.
- **`get_balance` reports only the spendable (local) side.** Inbound and pending
  are excluded, because a caller reads the balance as what it can spend.

Built to satisfy a strict NIP-44-only client: the kind 13194 info event always
carries `["encryption", "nip44_v2"]` and lists exactly the allowlist.

`list_transactions` (extension `05`) is not supported. Answering it honestly
means honouring `type`, `from`, `until`, `offset` and `unpaid` and merging
outgoing payments with incoming invoices; a partial version would mislead any
client that trusts the advertisement. `NWC_METHODS` refuses to start with a
method the bridge does not implement.

## Tests

```sh
npm test   # node --test, no running node or relay required
```

The request-handling core has no third-party imports and is tested against a
fake LND, covering the allowlist guard, the invoice-only default, `pay_invoice`
safety and the LND-to-NWC mapping.

## Support

For issues and feature requests, see [GitHub Issues](https://github.com/forgesworn/nwc-lnd-bridge/issues).

If nwc-lnd-bridge is useful to you, a tip is always welcome:

- Lightning: `profusemeat89@walletofsatoshi.com`
- Nostr zaps: `npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`

## Licence

MIT
