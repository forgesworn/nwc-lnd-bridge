# Security

Please report vulnerabilities privately through the
[GitHub security advisory form](https://github.com/forgesworn/nwc-lnd-bridge/security/advisories/new).
Do not open a public issue for an unpatched spending, secret-handling,
authentication or relay vulnerability.

## What the bridge protects

- The `nostr+walletconnect://` URI is a capability over the LND node. The
  bridge writes it and its keys to `DATA_DIR` with mode 0600 and never logs
  either. Anyone who can read that directory can use the node as far as the
  allowlist, the spend limits and the macaroon allow.
- Only the connection's own client key is served. Requests from any other
  author are ignored, as are requests whose NIP-40 `expiration` has passed.
- The method allowlist defaults to invoice-only. `pay_invoice` needs
  `MAX_PAY_MSAT` and `FEE_LIMIT_MSAT`; there is no daily or total budget, so
  fund the node with no more than the URI may lose.
- NIP-44 v2 only. Relays other than loopback must use `wss://`, and LND's TLS
  certificate is verified unless LND is on loopback or `LND_TLS_INSECURE=1`.

## Out of scope

The security of the LND node itself, its macaroons and its host, and of the
relays the bridge uses. Scope the macaroon (see the README) so the node refuses
what the bridge should never do, whatever its configuration.
