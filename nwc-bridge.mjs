#!/usr/bin/env node
/**
 * Minimal NWC-to-LND bridge
 *
 * Listens for NIP-47 (kind 23194) wallet requests on a relay, proxies them to
 * an LND REST API, and publishes responses (kind 23195). It is the LND analogue
 * of nwc-phoenixd-bridge: same NWC/relay/NIP-44 plumbing, a different wallet
 * backend.
 *
 * The emitted `nostr+walletconnect://` URI is a capability over the node it
 * fronts. This bridge scopes that capability with a method allowlist that
 * DEFAULTS TO INVOICE-ONLY: `make_invoice lookup_invoice list_transactions
 * get_info`. `pay_invoice` and `get_balance` are opt-in via NWC_METHODS, so a
 * URI pointed at a funds-holding node cannot spend or disclose its balance
 * unless you deliberately allow it. Prefer an invoice-baked macaroon as a
 * second, independent guard.
 *
 * Usage:
 *   LND_REST_URL=https://127.0.0.1:8080 \
 *   LND_MACAROON=<hex invoice.macaroon> \
 *   LND_CERT_PATH=/path/tls.cert \
 *   RELAY=wss://relay.damus.io \
 *   node nwc-bridge.mjs
 *
 * Prints the nostr+walletconnect:// URI on startup.
 *
 * The pure request-handling core (createHandler, mapInvoice, base64ToHex) has
 * no third-party imports and is exercised by nwc-bridge.test.mjs without a
 * running node. All Nostr and HTTP dependencies are loaded lazily in main().
 */

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

// Invoice-only. No pay_invoice (spend), no get_balance (disclosure).
export const DEFAULT_METHODS = ['make_invoice', 'lookup_invoice', 'list_transactions', 'get_info']

// NIP-47 error codes used below. Anything unexpected collapses to OTHER.
export function nwcError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// LND REST encodes hashes and preimages as standard base64; NWC wants hex.
export function base64ToHex(b64) {
  if (!b64) return ''
  return Buffer.from(b64, 'base64').toString('hex')
}

const nowSec = () => Math.floor(Date.now() / 1000)

// Map an LND invoice object (AddInvoice lookup / ListInvoices element) onto a
// NIP-47 transaction. `state` is set explicitly: a NIP-47 client keys
// settlement off it (a missing state reads as unsettled even with a preimage),
// so deriving it here rather than leaving it out is load-bearing.
export function mapInvoice(inv) {
  const settled = inv.state === 'SETTLED' || inv.settled === true
  const paidMsat = inv.amt_paid_msat && inv.amt_paid_msat !== '0' ? inv.amt_paid_msat : inv.value_msat
  const state = settled ? 'settled' : inv.state === 'CANCELED' ? 'failed' : 'pending'
  const created = inv.creation_date && inv.creation_date !== '0' ? Number(inv.creation_date) : undefined
  return {
    type: 'incoming',
    invoice: inv.payment_request,
    ...(inv.memo ? { description: inv.memo } : {}),
    payment_hash: base64ToHex(inv.r_hash),
    amount: Number(paidMsat || 0),
    state,
    // A preimage is only meaningful once settled; before that LND has none.
    preimage: settled ? base64ToHex(inv.r_preimage) : '',
    ...(settled && inv.settle_date && inv.settle_date !== '0'
      ? { settled_at: Number(inv.settle_date) }
      : {}),
    ...(created !== undefined ? { created_at: created } : {}),
    ...(created !== undefined && inv.expiry ? { expires_at: created + Number(inv.expiry) } : {}),
  }
}

function normalizePaymentHash(params) {
  const hash = params.payment_hash
  if (typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase()
  if (params.invoice) {
    throw nwcError('NOT_IMPLEMENTED', 'lookup by invoice is not supported; pass payment_hash')
  }
  throw nwcError('OTHER', 'lookup_invoice requires a 32-byte hex payment_hash')
}

/**
 * Build the NWC method dispatcher.
 *
 * @param lnd  async (httpMethod, path, body?) => parsed JSON. Injected so the
 *             handler is testable without a real node.
 * @param allowedMethods  iterable of permitted NIP-47 methods.
 */
export function createHandler({ lnd, allowedMethods }) {
  const allow = allowedMethods instanceof Set ? allowedMethods : new Set(allowedMethods)

  return async function handle(method, params = {}) {
    // The allowlist is the primary spend/disclosure guard. Refuse first, before
    // any call reaches the node, and refuse the same way whether the method is
    // unknown or merely disabled here.
    if (!allow.has(method)) {
      throw nwcError('RESTRICTED', `method ${method} is not permitted by this bridge`)
    }

    switch (method) {
      case 'get_info': {
        const info = await lnd('GET', '/v1/getinfo')
        return {
          ...(info.alias ? { alias: info.alias } : {}),
          ...(info.color ? { color: info.color } : {}),
          pubkey: info.identity_pubkey,
          ...(info.chains && info.chains[0] ? { network: info.chains[0].network } : {}),
          ...(info.block_height !== undefined ? { block_height: info.block_height } : {}),
          methods: [...allow],
        }
      }

      case 'get_balance': {
        const bal = await lnd('GET', '/v1/balance/channels')
        // Local balance is the spendable (outbound) side. Report msats. Inbound
        // and pending are deliberately excluded: a caller reads get_balance as
        // "what can I spend", and neither can be.
        const msat = bal.local_balance ? Number(bal.local_balance.msat) : Number(bal.balance || 0) * 1000
        return { balance: msat }
      }

      case 'make_invoice': {
        const amountMsat = Number(params.amount || 0)
        const body = {
          memo: params.description || '',
          expiry: String(params.expiry || 3600),
        }
        // Omit value_msat for a zero amount so LND mints an amountless invoice
        // rather than rejecting it.
        if (amountMsat > 0) body.value_msat = String(amountMsat)
        const inv = await lnd('POST', '/v1/invoices', body)
        return {
          type: 'incoming',
          invoice: inv.payment_request,
          payment_hash: base64ToHex(inv.r_hash),
          amount: amountMsat,
          ...(params.description ? { description: params.description } : {}),
          created_at: nowSec(),
        }
      }

      case 'lookup_invoice': {
        const hash = normalizePaymentHash(params)
        const inv = await lnd('GET', `/v1/invoice/${hash}`)
        return mapInvoice(inv)
      }

      case 'list_transactions': {
        const limit = Number(params.limit || 10)
        const query = new URLSearchParams({ num_max_invoices: String(limit), reversed: 'true' })
        const res = await lnd('GET', `/v1/invoices?${query.toString()}`)
        return { transactions: (res.invoices || []).map(mapInvoice) }
      }

      case 'pay_invoice': {
        const res = await lnd('POST', '/v1/channels/transactions', { payment_request: params.invoice })
        // LND reports a routing failure as payment_error with no preimage. The
        // preimage is the only proof of settlement, so its absence is never a
        // success: a definite failure throws PAYMENT_FAILED, a silent absence is
        // an unknown outcome the client must reconcile, not assume.
        if (res.payment_error) {
          throw nwcError('PAYMENT_FAILED', `payment failed: ${res.payment_error}`)
        }
        const preimage = base64ToHex(res.payment_preimage)
        if (!preimage) {
          throw nwcError('OTHER', 'payment returned no preimage, outcome unknown, reconcile before retrying')
        }
        return { preimage }
      }

      default:
        throw nwcError('NOT_IMPLEMENTED', `unsupported method: ${method}`)
    }
  }
}

// --- Runtime (only when executed directly) ---------------------------------

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href

async function main() {
  const { generateSecretKey, getPublicKey, finalizeEvent } = await import('nostr-tools/pure')
  const { getConversationKey, encrypt, decrypt } = await import('nostr-tools/nip44')
  const { Relay } = await import('nostr-tools/relay')

  const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'))
  const bytesToHex = (bytes) => Buffer.from(bytes).toString('hex')

  const LND_REST_URL = (process.env.LND_REST_URL || 'https://127.0.0.1:8080').replace(/\/$/, '')
  const LND_MACAROON = process.env.LND_MACAROON
  const RELAY_URL = process.env.RELAY || 'wss://relay.damus.io'
  const methods = (process.env.NWC_METHODS || DEFAULT_METHODS.join(' ')).split(/\s+/).filter(Boolean)
  const allowedMethods = new Set(methods)

  if (!LND_MACAROON || !/^[0-9a-f]+$/i.test(LND_MACAROON)) {
    console.error('LND_MACAROON is required and must be hex (bake an invoice-only macaroon for a funds node)')
    process.exit(1)
  }

  // TLS: LND serves a self-signed cert. Verify against it when given, otherwise
  // fall back to no verification with a loud warning (only acceptable on a
  // trusted localhost/docker network).
  let caPem
  if (process.env.LND_CERT_PATH) caPem = readFileSync(process.env.LND_CERT_PATH, 'utf8')
  else if (process.env.LND_CERT) caPem = process.env.LND_CERT.includes('BEGIN CERTIFICATE')
    ? process.env.LND_CERT
    : Buffer.from(process.env.LND_CERT, 'base64').toString('utf8')

  const { Agent } = await import('undici')
  const dispatcher = new Agent({ connect: caPem ? { ca: caPem } : { rejectUnauthorized: false } })
  if (!caPem) console.warn('WARNING: no LND_CERT(_PATH) given, TLS verification is OFF (localhost/docker only)')

  const lnd = async (httpMethod, path, body) => {
    const opts = { method: httpMethod, headers: { 'Grpc-Metadata-macaroon': LND_MACAROON }, dispatcher }
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
    const res = await fetch(`${LND_REST_URL}${path}`, opts)
    const text = await res.text()
    if (!res.ok) throw nwcError('INTERNAL', `lnd ${path}: ${res.status} ${text}`)
    return text ? JSON.parse(text) : {}
  }

  const handle = createHandler({ lnd, allowedMethods })

  const bridgeSecret = process.env.BRIDGE_SECRET ? hexToBytes(process.env.BRIDGE_SECRET) : generateSecretKey()
  const bridgePubkey = getPublicKey(bridgeSecret)
  const clientSecret = process.env.CLIENT_SECRET ? hexToBytes(process.env.CLIENT_SECRET) : generateSecretKey()
  const clientPubkey = getPublicKey(clientSecret)

  const nwcUri = `nostr+walletconnect://${bridgePubkey}?relay=${encodeURIComponent(RELAY_URL)}&secret=${bytesToHex(clientSecret)}`
  const spends = allowedMethods.has('pay_invoice')
  console.log('\nNWC URI:')
  console.log(nwcUri)
  console.log(`\nMethods: ${[...allowedMethods].join(' ')}`)
  console.log(`Capability: ${spends ? 'CAN SPEND (pay_invoice enabled)' : 'invoice-only (cannot spend)'}`)
  console.log(`Bridge pubkey: ${bridgePubkey}`)
  console.log(`Client pubkey: ${clientPubkey}`)
  console.log(`Relay: ${RELAY_URL}`)
  console.log(`LND: ${LND_REST_URL}\n`)
  if (!process.env.BRIDGE_SECRET) {
    console.log(`BRIDGE_SECRET=${bytesToHex(bridgeSecret)}`)
    console.log(`CLIENT_SECRET=${bytesToHex(clientSecret)}\n`)
  }

  const decryptRequest = (event) => {
    const key = getConversationKey(bridgeSecret, event.pubkey)
    return JSON.parse(decrypt(event.content, key))
  }
  const buildResponse = (requestEvent, resultType, result, error) => {
    const key = getConversationKey(bridgeSecret, requestEvent.pubkey)
    const payload = { result_type: resultType }
    if (error) payload.error = { code: error.code || 'OTHER', message: error.message }
    else payload.result = result
    return finalizeEvent({
      kind: 23195,
      created_at: nowSec(),
      tags: [['p', requestEvent.pubkey], ['e', requestEvent.id]],
      content: encrypt(JSON.stringify(payload), key),
    }, bridgeSecret)
  }

  const relay = await Relay.connect(RELAY_URL)
  console.log(`Connected to ${RELAY_URL}`)

  // Publish the replaceable kind 13194 info event. A strict NIP-44-only client
  // refuses a wallet that advertises no encryption tag, so this is required for
  // discovery, not optional. Advertise exactly the allowlist.
  const tags = [['encryption', 'nip44_v2']]
  if (allowedMethods.has('list_transactions')) tags.push(['extensions', '05'])
  await relay.publish(finalizeEvent({
    kind: 13194,
    created_at: nowSec(),
    tags,
    content: [...allowedMethods].join(' '),
  }, bridgeSecret))
  console.log(`Published info event (kind 13194): ${[...allowedMethods].join(' ')}`)

  const sub = relay.subscribe(
    [{ kinds: [23194], authors: [clientPubkey], '#p': [bridgePubkey], since: nowSec() - 10 }],
    {
      onevent: async (event) => {
        // Only the connection's own client may drive this wallet. The relay
        // filter already restricts authors; re-check here in case a relay
        // ignores it, so the client secret is a real credential rather than a
        // hint. Without this a pay-enabled URI would honour anyone.
        if (event.pubkey !== clientPubkey) return
        let request
        try {
          request = decryptRequest(event)
          console.log(`NWC request: ${request.method}`)
          const result = await handle(request.method, request.params || {})
          await relay.publish(buildResponse(event, request.method, result))
          console.log('  -> response published')
        } catch (err) {
          console.error(`  -> error: ${err.message}`)
          if (request) {
            try {
              await relay.publish(buildResponse(event, request.method, null, err))
            } catch { /* ignore double-error */ }
          }
        }
      },
    },
  )

  console.log('Listening for NWC requests...\n')
  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    sub.close()
    relay.close()
    process.exit(0)
  })
}

if (isMain) {
  main().catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
  })
}
