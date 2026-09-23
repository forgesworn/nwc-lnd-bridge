import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler, mapInvoice, base64ToHex, parseRelays, allowUnverifiedTls, watchRelayLiveness, parseMsat, isExpired, parseMethods, SUPPORTED_METHODS, relayRejection, loadOrCreateKeys, writePrivateFile, fingerprint, DEFAULT_METHODS } from './nwc-bridge.mjs'

const b64 = (byte) => Buffer.alloc(32, byte).toString('base64')
const hex = (byte) => byte.toString(16).padStart(2, '0').repeat(32)

// A fake LND REST endpoint: routes on "METHOD path" (path without query), and
// records what it was called with so tests can assert request shaping.
function fakeLnd(routes) {
  const calls = []
  const lnd = async (method, path, body) => {
    calls.push({ method, path, body })
    const key = `${method} ${path.split('?')[0]}`
    const handler = routes[key]
    if (!handler) throw new Error(`unexpected LND call: ${key}`)
    return typeof handler === 'function' ? handler(body) : handler
  }
  return { lnd, calls }
}

// Environment for running the real bridge process with no LND behind it. The
// runtime only calls LND when a request arrives, so startup needs none.
function bridgeTestEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    LND_REST_URL: 'https://127.0.0.1:1',
    LND_MACAROON: 'ab'.repeat(16),
    DATA_DIR: mkdtempSync(join(tmpdir(), 'nwc-bridge-')),
    ...extra,
  }
}

// A just-big-enough WebSocket relay for driving the real process: text frames
// only, which is all NIP-01 uses. `drop()` destroys the TCP socket without a
// close frame, which is how a relay restart or network loss looks.
async function startTestRelay(onMessage) {
  const sockets = new Set()
  const server = createServer()
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    const relay = {
      send(message) {
        const payload = Buffer.from(JSON.stringify(message))
        const header = payload.length < 126
          ? Buffer.from([0x81, payload.length])
          : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
        socket.write(Buffer.concat([header, payload]))
      },
      drop() { socket.destroy() },
    }
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) { length = buffer.readUInt16BE(2); offset = 4 }
        else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
        if (buffer.length < offset + 4 + length) return
        const mask = buffer.subarray(offset, offset + 4)
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length))
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        const opcode = buffer[0] & 0x0f
        buffer = buffer.subarray(offset + 4 + length)
        if (opcode === 0x1) onMessage(JSON.parse(payload.toString('utf8')), relay)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

const expectCode = (code) => (err) => {
  assert.equal(err.code, code, `expected NWC error code ${code}, got ${err.code} (${err.message})`)
  return true
}

test('base64ToHex decodes standard base64', () => {
  assert.equal(base64ToHex('EjRWeA=='), '12345678')
  assert.equal(base64ToHex(''), '')
})

test('make_invoice maps r_hash to hex and sends value_msat as a string', async () => {
  const { lnd, calls } = fakeLnd({
    'POST /v1/invoices': { r_hash: b64(0xab), payment_request: 'lnbc1test' },
  })
  const handle = createHandler({ lnd, allowedMethods: DEFAULT_METHODS })
  const res = await handle('make_invoice', { amount: 5000, description: 'coffee' })
  assert.equal(res.type, 'incoming')
  assert.equal(res.invoice, 'lnbc1test')
  assert.equal(res.payment_hash, hex(0xab))
  assert.equal(res.amount, 5000)
  assert.equal(res.description, 'coffee')
  assert.equal(calls[0].body.value_msat, '5000') // msat, string, not divided
  assert.equal(calls[0].body.memo, 'coffee')
})

test('make_invoice passes description_hash to LND as base64 of its bytes', async () => {
  const { lnd, calls } = fakeLnd({
    'POST /v1/invoices': { r_hash: b64(0xab), payment_request: 'lnbc1hash' },
  })
  const handle = createHandler({ lnd, allowedMethods: DEFAULT_METHODS })
  const res = await handle('make_invoice', { amount: 1000, description_hash: hex(0xcd).toUpperCase() })
  assert.equal(calls[0].body.description_hash, b64(0xcd))
  assert.equal(res.description_hash, hex(0xcd))

  await assert.rejects(handle('make_invoice', { amount: 1000, description_hash: 'abcd' }), expectCode('OTHER'))
  assert.equal(calls.length, 1)
})

test('make_invoice omits value_msat for a zero (amountless) invoice', async () => {
  const { lnd, calls } = fakeLnd({
    'POST /v1/invoices': { r_hash: b64(0x01), payment_request: 'lnbc1any' },
  })
  const handle = createHandler({ lnd, allowedMethods: DEFAULT_METHODS })
  await handle('make_invoice', {})
  assert.equal('value_msat' in calls[0].body, false)
})

test('lookup_invoice: settled invoice yields state settled + hex preimage + settled_at', async () => {
  const { lnd } = fakeLnd({
    ['GET /v1/invoice/' + hex(0xab)]: {
      state: 'SETTLED',
      r_hash: b64(0xab),
      r_preimage: b64(0xcd),
      payment_request: 'lnbc1x',
      value_msat: '1000',
      amt_paid_msat: '1000',
      settle_date: '1699999999',
      creation_date: '1699990000',
      expiry: '3600',
      memo: 'x',
    },
  })
  const handle = createHandler({ lnd, allowedMethods: DEFAULT_METHODS })
  const res = await handle('lookup_invoice', { payment_hash: hex(0xab) })
  assert.equal(res.state, 'settled')
  assert.equal(res.preimage, hex(0xcd))
  assert.equal(res.settled_at, 1699999999)
  assert.equal(res.amount, 1000)
  assert.equal(res.expires_at, 1699990000 + 3600)
})

test('lookup_invoice: an open invoice is pending with no preimage', async () => {
  const { lnd } = fakeLnd({
    ['GET /v1/invoice/' + hex(0x02)]: {
      state: 'OPEN', r_hash: b64(0x02), payment_request: 'lnbc1y', value_msat: '2000',
    },
  })
  const handle = createHandler({ lnd, allowedMethods: DEFAULT_METHODS })
  const res = await handle('lookup_invoice', { payment_hash: hex(0x02) })
  assert.equal(res.state, 'pending')
  assert.equal(res.preimage, '')
  assert.equal(res.settled_at, undefined)
})

test('lookup_invoice: rejects a missing or non-hex payment_hash', async () => {
  const handle = createHandler({ lnd: async () => ({}), allowedMethods: DEFAULT_METHODS })
  await assert.rejects(handle('lookup_invoice', {}), expectCode('OTHER'))
  await assert.rejects(handle('lookup_invoice', { invoice: 'lnbc1z' }), expectCode('NOT_IMPLEMENTED'))
  await assert.rejects(handle('lookup_invoice', { payment_hash: 'nothex' }), expectCode('OTHER'))
})

test('default allowlist is invoice-only: pay_invoice and get_balance are RESTRICTED', async () => {
  const handle = createHandler({ lnd: async () => ({}), allowedMethods: DEFAULT_METHODS })
  await assert.rejects(handle('pay_invoice', { invoice: 'lnbc1' }), expectCode('RESTRICTED'))
  await assert.rejects(handle('get_balance', {}), expectCode('RESTRICTED'))
})

const PAY = [...DEFAULT_METHODS, 'pay_invoice']
const LIMITS = { maxPayMsat: 50_000, feeLimitMsat: 1_000 }
const decodes = (numMsat) => ({ 'GET /v1/payreq/lnbc1': { num_msat: String(numMsat), num_satoshis: String(Math.floor(numMsat / 1000)) } })

test('pay_invoice, when enabled, requires a preimage and honours payment_error', async () => {
  const ok = createHandler({
    lnd: fakeLnd({ ...decodes(10_000), 'POST /v1/channels/transactions': { payment_error: '', payment_preimage: b64(0xee) } }).lnd,
    allowedMethods: PAY, ...LIMITS,
  })
  assert.deepEqual(await ok('pay_invoice', { invoice: 'lnbc1' }), { preimage: hex(0xee) })

  const routingFail = createHandler({
    lnd: fakeLnd({ ...decodes(10_000), 'POST /v1/channels/transactions': { payment_error: 'no_route', payment_preimage: '' } }).lnd,
    allowedMethods: PAY, ...LIMITS,
  })
  await assert.rejects(routingFail('pay_invoice', { invoice: 'lnbc1' }), expectCode('PAYMENT_FAILED'))

  // No error AND no preimage: an unknown outcome, never reported as success.
  const silent = createHandler({
    lnd: fakeLnd({ ...decodes(10_000), 'POST /v1/channels/transactions': { payment_error: '', payment_preimage: '' } }).lnd,
    allowedMethods: PAY, ...LIMITS,
  })
  await assert.rejects(silent('pay_invoice', { invoice: 'lnbc1' }), expectCode('OTHER'))
})

test('pay_invoice refuses to pay at all without configured limits', async () => {
  let touched = false
  const lnd = async () => { touched = true; return {} }
  for (const limits of [{}, { maxPayMsat: 50_000 }, { feeLimitMsat: 1_000 }, { maxPayMsat: 0, feeLimitMsat: 0 }]) {
    const handle = createHandler({ lnd, allowedMethods: PAY, ...limits })
    await assert.rejects(handle('pay_invoice', { invoice: 'lnbc1' }), expectCode('RESTRICTED'))
  }
  assert.equal(touched, false)
})

test('pay_invoice refuses an invoice above MAX_PAY_MSAT with QUOTA_EXCEEDED, before paying', async () => {
  const { lnd, calls } = fakeLnd({ ...decodes(50_001) })
  const handle = createHandler({ lnd, allowedMethods: PAY, ...LIMITS })
  await assert.rejects(handle('pay_invoice', { invoice: 'lnbc1' }), expectCode('QUOTA_EXCEEDED'))
  assert.deepEqual(calls.map((c) => c.path), ['/v1/payreq/lnbc1'])
})

test('pay_invoice passes FEE_LIMIT_MSAT to LND as fee_limit.fixed_msat', async () => {
  const { lnd, calls } = fakeLnd({
    ...decodes(50_000),
    'POST /v1/channels/transactions': { payment_preimage: b64(0xee), payment_route: { total_fees_msat: '12' } },
  })
  const handle = createHandler({ lnd, allowedMethods: PAY, ...LIMITS })
  assert.deepEqual(await handle('pay_invoice', { invoice: 'lnbc1' }), { preimage: hex(0xee), fees_paid: 12 })
  const pay = calls.find((c) => c.method === 'POST')
  assert.deepEqual(pay.body, { payment_request: 'lnbc1', fee_limit: { fixed_msat: '1000' } })
})

test('pay_invoice pays an amountless invoice for the NIP-47 amount, capped, as amt_msat', async () => {
  const route = { ...decodes(0), 'POST /v1/channels/transactions': { payment_preimage: b64(0xee) } }
  const { lnd, calls } = fakeLnd(route)
  const handle = createHandler({ lnd, allowedMethods: PAY, ...LIMITS })
  await handle('pay_invoice', { invoice: 'lnbc1', amount: 21_000 })
  assert.equal(calls.find((c) => c.method === 'POST').body.amt_msat, '21000')

  await assert.rejects(handle('pay_invoice', { invoice: 'lnbc1' }), expectCode('OTHER'))
  await assert.rejects(handle('pay_invoice', { invoice: 'lnbc1', amount: 50_001 }), expectCode('QUOTA_EXCEEDED'))
  await assert.rejects(handle('pay_invoice', { invoice: 'lnbc1', amount: -1 }), expectCode('OTHER'))
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
})

test('pay_invoice refuses an amount that contradicts the invoice', async () => {
  const { lnd, calls } = fakeLnd(decodes(10_000))
  const handle = createHandler({ lnd, allowedMethods: PAY, ...LIMITS })
  await assert.rejects(handle('pay_invoice', { invoice: 'lnbc1', amount: 1 }), expectCode('OTHER'))
  assert.equal(calls.some((c) => c.method === 'POST'), false)
})

test('parseMsat accepts whole msat values and refuses anything else', () => {
  assert.equal(parseMsat(undefined, 'X'), undefined)
  assert.equal(parseMsat('', 'X'), undefined)
  assert.equal(parseMsat('0', 'X'), 0)
  assert.equal(parseMsat(' 21000 ', 'X'), 21000)
  for (const bad of ['-1', '1.5', '1e3', 'abc', '99999999999999999999']) {
    assert.throws(() => parseMsat(bad, 'X'), /X must be/)
  }
})

test('get_info reports exactly the allowlist as its methods', async () => {
  const { lnd } = fakeLnd({
    'GET /v1/getinfo': { identity_pubkey: '02abc', alias: 'node', chains: [{ network: 'mainnet' }], block_height: 800000 },
  })
  const handle = createHandler({ lnd, allowedMethods: DEFAULT_METHODS })
  const res = await handle('get_info', {})
  assert.equal(res.pubkey, '02abc')
  assert.equal(res.network, 'mainnet')
  assert.deepEqual(res.methods, DEFAULT_METHODS)
})

test('an entirely unknown method is RESTRICTED before it can reach the node', async () => {
  let touched = false
  const handle = createHandler({ lnd: async () => { touched = true; return {} }, allowedMethods: DEFAULT_METHODS })
  await assert.rejects(handle('sign_message', {}), expectCode('RESTRICTED'))
  assert.equal(touched, false)
})

test('parseRelays splits on whitespace/commas, filters non-ws, and dedupes', () => {
  assert.deepEqual(parseRelays('wss://a.example'), ['wss://a.example'])
  assert.deepEqual(parseRelays('wss://a.example wss://b.example'), ['wss://a.example', 'wss://b.example'])
  assert.deepEqual(parseRelays('wss://a.example, wss://b.example , wss://a.example'), ['wss://a.example', 'wss://b.example'])
  assert.deepEqual(parseRelays('not-a-relay wss://ok.example http://nope.example'), ['wss://ok.example'])
  assert.deepEqual(parseRelays(''), [])
  assert.deepEqual(parseRelays(undefined), [])
})

test('mapInvoice treats a CANCELED invoice as failed', () => {
  const res = mapInvoice({ state: 'CANCELED', r_hash: b64(0x03), payment_request: 'lnbc1c' })
  assert.equal(res.state, 'failed')
  assert.equal(res.preimage, '')
})

test('allowUnverifiedTls permits loopback only, unless LND_TLS_INSECURE=1', () => {
  assert.equal(allowUnverifiedTls('https://127.0.0.1:8080'), true)
  assert.equal(allowUnverifiedTls('https://localhost:8080'), true)
  assert.equal(allowUnverifiedTls('https://[::1]:8080'), true)
  assert.equal(allowUnverifiedTls('https://host.docker.internal:8080'), false)
  assert.equal(allowUnverifiedTls('https://lnd.example.com:8080'), false)
  assert.equal(allowUnverifiedTls('https://127.0.0.1.evil.example:8080'), false)
  assert.equal(allowUnverifiedTls('not a url'), false)
  assert.equal(allowUnverifiedTls('https://lnd.example.com:8080', '1'), true)
  assert.equal(allowUnverifiedTls('https://lnd.example.com:8080', 'true'), false)
})

test('watchRelayLiveness fires once, only when the last relay subscription closes', () => {
  let fired = 0
  const watch = watchRelayLiveness(['wss://a.example', 'wss://b.example'], () => { fired++ })
  watch.closed('wss://a.example')
  assert.equal(fired, 0)
  assert.deepEqual(watch.live, ['wss://b.example'])
  watch.closed('wss://a.example') // a repeat close of a dead relay changes nothing
  assert.equal(fired, 0)
  watch.closed('wss://b.example')
  assert.equal(fired, 1)
  watch.closed('wss://b.example')
  assert.equal(fired, 1)
})

test('the bridge exits non-zero when its only relay drops', async () => {
  // Drive the real runtime against a local relay that closes the socket as
  // soon as the REQ arrives. Before the fix the process stayed up, deaf.
  const server = await startTestRelay((message, relay) => {
    if (message[0] === 'EVENT') relay.send(['OK', message[1].id, true, ''])
    if (message[0] === 'REQ') setTimeout(() => relay.drop(), 50)
  })
  const child = spawn(process.execPath, ['nwc-bridge.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...bridgeTestEnv(), RELAY: server.url },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout') }, 10_000)
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
  })
  server.close()
  assert.equal(code, 1, `expected exit 1, got ${code}; stderr: ${stderr}`)
  assert.match(stderr, /All relay subscriptions closed/)
})

const modeOf = (path) => statSync(path).mode & 0o777

test('loadOrCreateKeys persists new secrets owner-only and reuses them', () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'nwc-keys-')), 'nested')
  let n = 0
  const generate = () => hex(++n)
  const first = loadOrCreateKeys({ dataDir, generate })
  assert.equal(first.source, 'new')
  assert.equal(modeOf(join(dataDir, 'keys.json')), 0o600)
  assert.equal(modeOf(dataDir), 0o700)
  const second = loadOrCreateKeys({ dataDir, generate })
  assert.equal(second.source, 'file')
  assert.equal(second.bridgeSecret, first.bridgeSecret)
  assert.equal(second.clientSecret, first.clientSecret)
})

test('loadOrCreateKeys honours both env secrets, refuses one, and refuses bad hex', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'nwc-keys-'))
  const generate = () => { throw new Error('should not generate') }
  const keys = loadOrCreateKeys({ dataDir, env: { BRIDGE_SECRET: hex(1), CLIENT_SECRET: hex(2) }, generate })
  assert.equal(keys.source, 'env')
  assert.equal(existsSync(join(dataDir, 'keys.json')), false)
  assert.throws(() => loadOrCreateKeys({ dataDir, env: { BRIDGE_SECRET: hex(1) }, generate }), /both/)
  assert.throws(() => loadOrCreateKeys({ dataDir, env: { BRIDGE_SECRET: 'zz', CLIENT_SECRET: hex(2) }, generate }), /hex/)
})

test('writePrivateFile tightens a file that already existed with loose permissions', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nwc-uri-')), 'nwc-uri.txt')
  writeFileSync(path, 'old', { mode: 0o644 })
  writePrivateFile(path, 'new')
  assert.equal(readFileSync(path, 'utf8'), 'new')
  assert.equal(modeOf(path), 0o600)
})

test('fingerprint shortens a pubkey', () => {
  assert.equal(fingerprint(hex(0xab)), 'abababab…abababab')
})

test('the running bridge writes the URI to an owner-only file and never logs a secret', async () => {
  const server = await startTestRelay((message, relay) => {
    if (message[0] === 'EVENT') relay.send(['OK', message[1].id, true, ''])
  })
  const env = bridgeTestEnv({ RELAY: server.url })
  const child = spawn(process.execPath, ['nwc-bridge.mjs'], {
    cwd: new URL('.', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${output}`)), 10_000)
    child.stdout.on('data', () => { if (output.includes('Listening')) { clearTimeout(timer); resolve() } })
  })
  child.kill('SIGTERM')
  await new Promise((resolve) => child.on('exit', resolve))
  server.close()

  const uriPath = join(env.DATA_DIR, 'nwc-uri.txt')
  const keys = JSON.parse(readFileSync(join(env.DATA_DIR, 'keys.json'), 'utf8'))
  assert.equal(modeOf(uriPath), 0o600)
  assert.equal(modeOf(join(env.DATA_DIR, 'keys.json')), 0o600)
  assert.match(readFileSync(uriPath, 'utf8'), new RegExp(`^nostr\\+walletconnect://[0-9a-f]{64}\\?relay=.+&secret=${keys.client_secret}\\n$`))
  assert.ok(output.includes(uriPath), 'the URI file path is printed')
  assert.ok(!output.includes(keys.client_secret), 'the client secret must not be logged')
  assert.ok(!output.includes(keys.bridge_secret), 'the bridge secret must not be logged')
  assert.ok(!output.includes('nostr+walletconnect://'), 'the URI must not be logged')
})

test('isExpired follows NIP-40', () => {
  const at = (value) => ({ tags: [['p', 'x'], ['expiration', value]] })
  assert.equal(isExpired({ tags: [] }, 1000), false)
  assert.equal(isExpired(at('1001'), 1000), false)
  assert.equal(isExpired(at('1000'), 1000), true)
  assert.equal(isExpired(at('999'), 1000), true)
  assert.equal(isExpired(at('soon'), 1000), true) // unreadable expiry fails closed
})

test('the running bridge ignores an expired request and serves a live one', async () => {
  const { finalizeEvent, getPublicKey } = await import('nostr-tools/pure')
  const { getConversationKey, encrypt } = await import('nostr-tools/nip44')
  const bridgeSecret = hex(0x11)
  const clientSecret = Uint8Array.from(Buffer.from(hex(0x22), 'hex'))
  const bridgePubkey = getPublicKey(Uint8Array.from(Buffer.from(bridgeSecret, 'hex')))
  const key = getConversationKey(clientSecret, bridgePubkey)
  const now = Math.floor(Date.now() / 1000)
  const request = (method, expiration) => finalizeEvent({
    kind: 23194,
    created_at: now,
    tags: [['p', bridgePubkey], ['expiration', String(expiration)]],
    content: encrypt(JSON.stringify({ method, params: {} }), key),
  }, clientSecret)

  const server = await startTestRelay((message, relay) => {
    if (message[0] === 'EVENT') relay.send(['OK', message[1].id, true, ''])
    if (message[0] === 'REQ') {
      relay.send(['EVENT', message[1], request('make_invoice', now - 5)])
      relay.send(['EVENT', message[1], request('lookup_invoice', now + 60)])
    }
  })
  const env = bridgeTestEnv({ RELAY: server.url, BRIDGE_SECRET: bridgeSecret, CLIENT_SECRET: hex(0x22) })
  const child = spawn(process.execPath, ['nwc-bridge.mjs'], {
    cwd: new URL('.', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no request handled: ${output}`)), 10_000)
    const onData = (chunk) => {
      output += chunk
      if (output.includes('NWC request: lookup_invoice')) { clearTimeout(timer); resolve() }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
  try {
    await done
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.on('exit', resolve))
    server.close()
  }
  assert.match(output, /dropped an expired request/)
  assert.doesNotMatch(output, /NWC request: make_invoice/)
})

test('list_transactions is neither a default nor accepted, so it is never advertised', async () => {
  assert.equal(DEFAULT_METHODS.includes('list_transactions'), false)
  assert.equal(SUPPORTED_METHODS.includes('list_transactions'), false)
  assert.throws(() => parseMethods('make_invoice list_transactions'), /unsupported methods: list_transactions/)
  // Even if a caller forces it into the allowlist, nothing reaches LND.
  let touched = false
  const handle = createHandler({ lnd: async () => { touched = true; return {} }, allowedMethods: ['list_transactions'] })
  await assert.rejects(handle('list_transactions', { limit: 1000 }), expectCode('NOT_IMPLEMENTED'))
  assert.equal(touched, false)
})

test('parseMethods defaults to invoice-only and accepts supported opt-ins', () => {
  assert.deepEqual([...parseMethods('')], DEFAULT_METHODS)
  assert.deepEqual([...parseMethods(undefined)], DEFAULT_METHODS)
  assert.deepEqual([...parseMethods('make_invoice pay_invoice,get_info')], ['make_invoice', 'pay_invoice', 'get_info'])
  assert.throws(() => parseMethods('sign_message'), /unsupported/)
})

test('relays must be wss://, except ws:// on loopback', () => {
  assert.equal(relayRejection('wss://relay.example'), undefined)
  assert.equal(relayRejection('ws://127.0.0.1:7777'), undefined)
  assert.equal(relayRejection('ws://localhost:7777'), undefined)
  assert.equal(relayRejection('ws://[::1]:7777'), undefined)
  assert.match(relayRejection('ws://relay.example'), /loopback/)
  assert.match(relayRejection('ws://127.0.0.1.evil.example'), /loopback/)
  assert.ok(relayRejection('http://relay.example'))
  assert.ok(relayRejection('not a url'))
  assert.deepEqual(parseRelays('ws://relay.example wss://ok.example ws://127.0.0.1:1'), ['wss://ok.example', 'ws://127.0.0.1:1'])
})

test('the bridge refuses to start with a plaintext remote relay', async () => {
  const child = spawn(process.execPath, ['nwc-bridge.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: bridgeTestEnv({ RELAY: 'wss://relay.example ws://relay.example' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout') }, 10_000)
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
  })
  assert.equal(code, 1)
  assert.match(stderr, /ws:\/\/relay\.example refused/)
})
