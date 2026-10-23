import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {
  parseIp,
  isPrivateOrBlockedIp,
  isBlockedHostname,
  isHostInScope,
  resolveAndValidateHost,
  createSecurityProxy,
  normalizeAllowedOrigin,
  isManualLoginPostAllowed,
  isApprovedWritePostAllowed,
} from './exploration/networkSecurity.mjs'

test('IP parser parses IPv4, IPv6, and IPv4-mapped IPv6 accurately', () => {
  assert.equal(parseIp('127.0.0.1')?.canonical, '127.0.0.1')
  assert.equal(parseIp('8.8.8.8')?.canonical, '8.8.8.8')
  assert.equal(parseIp('::1')?.version, 6)
  assert.equal(parseIp('[::1]')?.version, 6)
  assert.equal(parseIp('fe80::1')?.version, 6)
  assert.equal(parseIp('::ffff:127.0.0.1')?.version, 6)
  assert.equal(parseIp('not-an-ip'), null)
})

test('IP security classifier identifies all private and reserved IPv4 ranges', () => {
  // Loopback
  assert.equal(isPrivateOrBlockedIp('127.0.0.1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('127.255.255.255').blocked, true)
  // RFC 1918 Private
  assert.equal(isPrivateOrBlockedIp('10.0.0.1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('10.255.255.254').blocked, true)
  assert.equal(isPrivateOrBlockedIp('172.16.0.1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('172.31.255.254').blocked, true)
  assert.equal(isPrivateOrBlockedIp('192.168.1.1').blocked, true)
  // Cloud metadata & Link-Local
  assert.equal(isPrivateOrBlockedIp('169.254.169.254').blocked, true)
  assert.equal(isPrivateOrBlockedIp('169.254.1.1').blocked, true)
  // Carrier-grade NAT (100.64.0.0/10)
  assert.equal(isPrivateOrBlockedIp('100.64.0.1').blocked, true)
  // Documentation test nets
  assert.equal(isPrivateOrBlockedIp('192.0.2.1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('198.51.100.1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('203.0.113.1').blocked, true)
  // Multicast and Broadcast
  assert.equal(isPrivateOrBlockedIp('224.0.0.1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('255.255.255.255').blocked, true)
  assert.equal(isPrivateOrBlockedIp('0.0.0.0').blocked, true)

  // Public IPv4 addresses must NOT be blocked
  assert.equal(isPrivateOrBlockedIp('8.8.8.8').blocked, false)
  assert.equal(isPrivateOrBlockedIp('93.184.216.34').blocked, false)
  assert.equal(isPrivateOrBlockedIp('1.1.1.1').blocked, false)
})

test('IP security classifier identifies prohibited IPv6 ranges and IPv4-mapped IPv6', () => {
  // Loopback and unspecified
  assert.equal(isPrivateOrBlockedIp('::1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('::').blocked, true)
  // Link-local
  assert.equal(isPrivateOrBlockedIp('fe80::1').blocked, true)
  // Unique Local Address (fc00::/7)
  assert.equal(isPrivateOrBlockedIp('fc00::1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('fd12:3456:789a::1').blocked, true)
  // Documentation (2001:db8::/32)
  assert.equal(isPrivateOrBlockedIp('2001:db8::1').blocked, true)
  // IPv4-mapped IPv6 to private/loopback/metadata
  assert.equal(isPrivateOrBlockedIp('::ffff:127.0.0.1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('::ffff:10.0.0.1').blocked, true)
  assert.equal(isPrivateOrBlockedIp('::ffff:169.254.169.254').blocked, true)
  // 6to4 embedding private IPv4 (127.0.0.1 -> 7f00:0001)
  assert.equal(isPrivateOrBlockedIp('2002:7f00:0001::').blocked, true)

  // Public IPv6 must NOT be blocked
  assert.equal(isPrivateOrBlockedIp('2606:4700:4700::1111').blocked, false)
  assert.equal(isPrivateOrBlockedIp('2001:4860:4860::8888').blocked, false)
  assert.equal(isPrivateOrBlockedIp('::ffff:8.8.8.8').blocked, false)
  assert.equal(isPrivateOrBlockedIp('4000::1').blocked, true, 'IPv6 outside global unicast space is prohibited')
})

test('Hostname security checks block dangerous suffixes and metadata names', () => {
  assert.equal(isBlockedHostname('localhost'), true)
  assert.equal(isBlockedHostname('foo.localhost'), true)
  assert.equal(isBlockedHostname('service.local'), false)
  assert.equal(isBlockedHostname('internal.corp'), false)
  assert.equal(isBlockedHostname('metadata.google.internal'), true)
  assert.equal(isBlockedHostname('instance-data'), true)
  assert.equal(isBlockedHostname('metadata.azure.com'), true)

  assert.equal(isBlockedHostname('example.com'), false)
  assert.equal(isBlockedHostname('sub.app.example.com'), false)
})

test('Scope checker permits exact and subdomains while preventing suffix spoofing', () => {
  assert.equal(isHostInScope('example.com', 'example.com'), true)
  assert.equal(isHostInScope('api.example.com', 'example.com'), true)
  assert.equal(isHostInScope('sub.api.example.com', 'example.com'), true)

  // Suffix spoofing attempts must be rejected
  assert.equal(isHostInScope('attacker-example.com', 'example.com'), false)
  assert.equal(isHostInScope('example.com.evil.com', 'example.com'), false)
  assert.equal(isHostInScope('other.com', 'example.com'), false)
})

test('Origin normalization is case, trailing-dot and IDN consistent and rejects unsafe ports', () => {
  assert.equal(normalizeAllowedOrigin('HTTPS://ExAmPlE.COM./'), 'https://example.com')
  assert.equal(normalizeAllowedOrigin('https://bücher.example'), 'https://xn--bcher-kva.example')
  assert.equal(normalizeAllowedOrigin('http://intranet.corp'), 'http://intranet.corp')
  assert.throws(() => normalizeAllowedOrigin('https://example.com:8443'), /standard web ports/)
  assert.throws(() => normalizeAllowedOrigin('https://user:pass@example.com'), /only an HTTP or HTTPS origin/)
})

test('DNS resolution rejects mixed public and prohibited IP responses', async () => {
  const mixedDns = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 }, // Poisoned with loopback
  ]

  await assert.rejects(
    resolveAndValidateHost('mixed.example.com', { dnsLookup: mixedDns }),
    /prohibited IP 127.0.0.1/
  )
})

test('DNS resolution rejects responses containing only prohibited IPs', async () => {
  const privateDns = async () => [
    { address: '10.0.0.5', family: 4 },
  ]

  await assert.rejects(
    resolveAndValidateHost('internal.example.com', { dnsLookup: privateDns }),
    /prohibited IP 10.0.0.5/
  )
})

test('DNS resolution succeeds for purely public IPs and returns pinned IP', async () => {
  const publicDns = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '93.184.216.35', family: 4 },
  ]

  const result = await resolveAndValidateHost('public.example.com', { dnsLookup: publicDns })
  assert.equal(result.hostname, 'public.example.com')
  assert.equal(result.pinnedIp, '93.184.216.34')
  assert.equal(result.allIps.length, 2)
})

test('Public IPv6 literals are normalized and returned as pinnable destinations', async () => {
  const result = await resolveAndValidateHost('[2606:4700:4700::1111]')
  assert.equal(result.hostname, '2606:4700:4700::1111')
  assert.equal(result.pinnedIp, '2606:4700:4700::1111')
})

test('Outbound security proxy drops requests to prohibited destinations and unapproved hosts', async () => {
  let prohibitedHits = 0
  const prohibitedServer = http.createServer((_req, res) => {
    prohibitedHits++
    res.writeHead(200)
    res.end('Prohibited secret data')
  })

  await new Promise((resolve) => prohibitedServer.listen(0, '127.0.0.1', resolve))
  const prohibitedPort = prohibitedServer.address().port

  const violations = []
  const proxy = await createSecurityProxy({
    allowedHost: 'approved.example.com',
    onSecurityViolation: (v) => violations.push(v),
  })

  try {
    // 1. Direct request to localhost / 127.0.0.1 through proxy
    const res1 = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        method: 'GET',
        path: `http://127.0.0.1:${prohibitedPort}/secret`,
      }, resolve)
      req.end()
    })
    assert.equal(res1.statusCode, 403)
    assert.equal(prohibitedHits, 0, 'Prohibited endpoint must receive 0 hits')

    // 2. Unapproved out-of-scope host
    const res2 = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        method: 'GET',
        path: 'http://evil.com/payload',
      }, resolve)
      req.end()
    })
    assert.equal(res2.statusCode, 403)

    // 3. Non-standard port attempt
    const res3 = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        method: 'GET',
        path: 'http://approved.example.com:8080/admin',
      }, resolve)
      req.end()
    })
    assert.equal(res3.statusCode, 403)

    // 4. HTTPS CONNECT to prohibited host/port
    const connectResult = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
        sock.write(`CONNECT 127.0.0.1:${prohibitedPort} HTTP/1.1\r\nHost: 127.0.0.1:${prohibitedPort}\r\n\r\n`)
      })
      let buf = ''
      sock.on('data', (d) => { buf += d.toString() })
      sock.on('close', () => resolve(buf))
    })
    assert.match(connectResult, /403 Forbidden/)
    assert.equal(prohibitedHits, 0, 'Prohibited server must NEVER be reached via CONNECT tunnel')
  } finally {
    await proxy.close()
    await new Promise((resolve) => prohibitedServer.close(resolve))
  }
})

test('Outbound proxy allows an explicitly approved exact resource origin without widening the primary host', async () => {
  const resourceServer = http.createServer((_req, res) => { res.writeHead(200); res.end('resource-ok') })
  await new Promise((resolve) => resourceServer.listen(0, '127.0.0.1', resolve))
  const violations = []
  const proxy = await createSecurityProxy({
    allowedHost: 'app.example.com',
    primaryOrigin: 'https://app.example.com',
    resourceOrigins: ['http://static.example.net'],
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    testTargetIp: '127.0.0.1',
    testTargetPort: resourceServer.address().port,
    onSecurityViolation: (item) => violations.push(item),
  })
  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxy.port, path: 'http://static.example.net/site.css' }, resolve)
      request.on('error', reject)
      request.end()
    })
    let body = ''
    for await (const chunk of response) body += chunk
    assert.equal(response.statusCode, 200)
    assert.equal(body, 'resource-ok')

    const blocked = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxy.port, path: 'http://other.example.net/site.css' }, resolve)
      request.on('error', reject)
      request.end()
    })
    assert.equal(blocked.statusCode, 403)
    assert.ok(violations.some((item) => item.type === 'OUT_OF_SCOPE'))
  } finally {
    await proxy.close()
    await new Promise((resolve) => resourceServer.close(resolve))
  }
})

test('Registered browser sessions can reach public cross-domain origins while private DNS targets remain blocked', async () => {
  let hits = 0
  const fixtureServer = http.createServer((_request, response) => {
    hits += 1
    response.writeHead(200)
    response.end('public-cross-origin-ok')
  })
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))
  const proxy = await createSecurityProxy({
    allowedHost: 'youtube.example.test',
    primaryOrigin: 'https://youtube.example.test',
    allowPublicOrigins: true,
    internalOrigins: ['http://authorized.corp'],
    dnsLookup: async (hostname) => [{ address: ['internal.example.test', 'authorized.corp'].includes(hostname) ? '10.0.0.8' : '93.184.216.34', family: 4 }],
    testTargetIp: '127.0.0.1',
    testTargetPort: fixtureServer.address().port,
  })
  try {
    const publicResponse = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxy.port, path: 'https://accounts.example.net/signin' }, resolve)
      request.on('error', reject)
      request.end()
    })
    let body = ''
    for await (const chunk of publicResponse) body += chunk
    assert.equal(publicResponse.statusCode, 200)
    assert.equal(body, 'public-cross-origin-ok')

    const internalResponse = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxy.port, path: 'http://internal.example.test/admin' }, resolve)
      request.on('error', reject)
      request.end()
    })
    assert.equal(internalResponse.statusCode, 403)
    assert.equal(hits, 1, 'Unconfigured private-address request must not reach the destination server')

    const configuredInternal = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxy.port, path: 'http://authorized.corp/hr' }, resolve)
      request.on('error', reject)
      request.end()
    })
    assert.equal(configuredInternal.statusCode, 200)
    assert.equal(hits, 2, 'Only the explicitly configured internal origin may reach the private fixture')
  } finally {
    await proxy.close()
    await new Promise((resolve) => fixtureServer.close(resolve))
  }
})

test('Manual authentication allows only the active, form-encoded registered login action path', async () => {
  let hits = 0
  const loginServer = http.createServer(async (req, res) => {
    hits += 1
    for await (const _chunk of req) {}
    res.writeHead(200)
    res.end('login-post-ok')
  })
  await new Promise((resolve) => loginServer.listen(0, '127.0.0.1', resolve))
  let loginGateOpen = false
  const proxy = await createSecurityProxy({
    allowedHost: 'app.example.com',
    primaryOrigin: 'http://app.example.com',
    manualAuthOrigin: 'http://app.example.com',
    manualAuthPaths: new Set(['/login']),
    isManualAuthActive: () => loginGateOpen,
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    testTargetIp: '127.0.0.1',
    testTargetPort: loginServer.address().port,
  })
  const sendPost = (url, contentType = 'application/x-www-form-urlencoded') => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: url, headers: { 'content-type': contentType } }, resolve)
    request.on('error', reject)
    request.end('form=fixture')
  })
  try {
    const closedGate = await sendPost('http://app.example.com/login')
    assert.equal(closedGate.statusCode, 403)
    loginGateOpen = true
    const allowed = await sendPost('http://app.example.com/login')
    assert.equal(allowed.statusCode, 200)
    const wrongOrigin = await sendPost('http://other.example.com/login')
    assert.equal(wrongOrigin.statusCode, 403)
    const wrongPath = await sendPost('http://app.example.com/other-action')
    assert.equal(wrongPath.statusCode, 403)
    const wrongContentType = await sendPost('http://app.example.com/login', 'application/json')
    assert.equal(wrongContentType.statusCode, 403)
    assert.equal(hits, 1)
  } finally {
    await proxy.close()
    await new Promise((resolve) => loginServer.close(resolve))
  }
})

test('Manual login POST policy accepts an XHR-style request only for the rendered same-origin form action', () => {
  const paths = new Set(['/ords/wwv_flow.accept'])
  const active = () => true
  const common = {
    method: 'POST',
    targetUrl: 'https://oracleapex.com/ords/wwv_flow.accept?p=redacted',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    manualAuthOrigin: 'https://oracleapex.com',
    manualAuthPaths: paths,
    isManualAuthActive: active,
  }
  assert.equal(isManualLoginPostAllowed(common), true)
  assert.equal(isManualLoginPostAllowed({ ...common, targetUrl: 'https://oracleapex.com/unrelated' }), false)
  assert.equal(isManualLoginPostAllowed({ ...common, targetUrl: 'https://other.example/ords/wwv_flow.accept' }), false)
  assert.equal(isManualLoginPostAllowed({ ...common, contentType: 'application/json' }), false)
  assert.equal(isManualLoginPostAllowed({ ...common, isManualAuthActive: () => false }), false)
  assert.equal(isManualLoginPostAllowed({ ...common, method: 'PUT' }), false)
})

test('Manual authentication permits an observed form on a public federated sign-in origin only', () => {
  const federated = {
    method: 'POST',
    targetUrl: 'https://accounts.google.example/signin',
    contentType: 'application/x-www-form-urlencoded',
    manualAuthOrigin: 'https://youtube.example',
    manualAuthOrigins: new Set(['https://youtube.example', 'https://accounts.google.example']),
    manualAuthPaths: new Set(['https://accounts.google.example/signin']),
    isManualAuthActive: () => true,
  }
  assert.equal(isManualLoginPostAllowed(federated), true)
  assert.equal(isManualLoginPostAllowed({ ...federated, targetUrl: 'https://accounts.google.example/unobserved' }), false)
  assert.equal(isManualLoginPostAllowed({ ...federated, targetUrl: 'https://attacker.example/signin' }), false)
})

test('Approved business writes are limited to the active operation form path and registered origin', () => {
  const authorization = { operation: 'create', origin: 'https://app.example.test', path: '/records' }
  const common = { method: 'POST', targetUrl: 'https://app.example.test/records?csrf=redacted', contentType: 'application/x-www-form-urlencoded', authorization }
  assert.equal(isApprovedWritePostAllowed(common), true)
  assert.equal(isApprovedWritePostAllowed({ ...common, targetUrl: 'https://app.example.test/other' }), false)
  assert.equal(isApprovedWritePostAllowed({ ...common, targetUrl: 'https://other.example.test/records' }), false)
  assert.equal(isApprovedWritePostAllowed({ ...common, contentType: 'application/json' }), false)
  assert.equal(isApprovedWritePostAllowed({ ...common, method: 'DELETE' }), false)
  assert.equal(isApprovedWritePostAllowed({ ...common, authorization: { ...authorization, operation: 'arbitrary' } }), false)
})
