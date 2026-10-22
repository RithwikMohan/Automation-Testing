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
})

test('Hostname security checks block dangerous suffixes and metadata names', () => {
  assert.equal(isBlockedHostname('localhost'), true)
  assert.equal(isBlockedHostname('foo.localhost'), true)
  assert.equal(isBlockedHostname('service.local'), true)
  assert.equal(isBlockedHostname('internal.corp'), true)
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
