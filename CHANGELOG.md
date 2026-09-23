# Changelog

## 0.1.0

First tagged version. Run from source or Docker; not published to npm.

- NIP-47 wallet service in front of an LND node over its REST API, NIP-44 v2
  only, serving one connection on one or more relays.
- Method allowlist that defaults to invoice-only (`make_invoice`,
  `lookup_invoice`, `list_transactions`, `get_info`). `pay_invoice` and
  `get_balance` are opt-in through `NWC_METHODS`.
- Refuses to start without LND's TLS certificate unless LND is on loopback or
  `LND_TLS_INSECURE=1` is set, since the macaroon travels in every request.
