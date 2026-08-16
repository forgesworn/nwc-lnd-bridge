# nwc-lnd-bridge

A minimal NIP-47 (Nostr Wallet Connect) wallet service in front of an LND node.
It listens for kind 23194 requests on a relay, proxies them to LND's REST API,
and publishes kind 23195 responses. On startup it prints a
`nostr+walletconnect://` URI.

It is the LND analogue of
[`nwc-phoenixd-bridge`](https://github.com/forgesworn/nwc-phoenixd-bridge): the
same NWC, relay and NIP-44 plumbing, with LND as the backend instead of
phoenixd. That turns any LND, including a mint's node, into a reusable NWC
wallet for clients like [`@forgesworn/nwc-kit`](https://github.com/forgesworn/nwc-kit)
and the merchant backend in
[`toll-booth`](https://github.com/forgesworn/toll-booth).

## The URI is a capability. Scope it.

The printed URI is a spending-and-query capability over the node it fronts.
Treat `BRIDGE_SECRET` + `CLIENT_SECRET` like a password. Two independent guards
keep it safe to point at a funds-holding node:

1. **Method allowlist, invoice-only by default.** With `NWC_METHODS` unset the
   bridge serves only `make_invoice`, `lookup_invoice`, `list_transactions` and
   `get_info`. It advertises exactly that set in its kind 13194 info event and
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

To deliberately run a full wallet (own funds, not a mint), list the methods:

```sh
NWC_METHODS="make_invoice lookup_invoice pay_invoice get_balance get_info"
```

## Run

Node 22+ directly:

```sh
npm install
LND_REST_URL=https://127.0.0.1:8080 \
LND_MACAROON=$(xxd -p -c 2000 invoice.macaroon | tr -d '\n') \
LND_CERT_PATH=/path/to/tls.cert \
RELAY=wss://relay.damus.io \
npm start
```

Or Docker (see `docker-compose.yml`, copy `.env.example` to `.env` first):

```sh
docker compose up -d --build
docker compose logs nwc-lnd-bridge   # the NWC URI is printed here
```

Set `BRIDGE_SECRET` and `CLIENT_SECRET` (printed on first run) in `.env` to keep
the same URI across restarts.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LND_REST_URL` | `https://127.0.0.1:8080` | LND REST endpoint |
| `LND_MACAROON` | (required) | Hex-encoded macaroon; invoice-only for a funds node |
| `LND_CERT_PATH` / `LND_CERT` | none | LND `tls.cert` (path, or inline PEM / base64). If absent, TLS verification is off, acceptable only on localhost/docker |
| `RELAY` | `wss://relay.damus.io` | Relay(s) to serve NWC on. One URL, or several separated by spaces or commas, for resilience |
| `NWC_METHODS` | invoice-only set | Space-separated method allowlist |
| `BRIDGE_SECRET` / `CLIENT_SECRET` | random | Hex 32-byte keys; set to persist the URI |

## Method map

| NIP-47 method | LND REST |
| --- | --- |
| `make_invoice` | `POST /v1/invoices` (`value_msat`) |
| `lookup_invoice` | `GET /v1/invoice/{payment_hash}` |
| `list_transactions` | `GET /v1/invoices?reversed=true` |
| `get_info` | `GET /v1/getinfo` |
| `get_balance` (opt-in) | `GET /v1/balance/channels` (local/spendable) |
| `pay_invoice` (opt-in) | `POST /v1/channels/transactions` |

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
- **`get_balance` reports only the spendable (local) side.** Inbound and pending
  are excluded, because a caller reads the balance as what it can spend.

Built to satisfy a strict NIP-44-only client: the kind 13194 info event always
carries `["encryption", "nip44_v2"]`, and `list_transactions` is advertised as
extension `05`.

## Tests

```sh
npm test   # node --test, no running node or relay required
```

The request-handling core has no third-party imports and is tested against a
fake LND, covering the allowlist guard, the invoice-only default, `pay_invoice`
safety and the LND-to-NWC mapping.

## License

MIT
