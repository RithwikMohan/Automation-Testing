import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns/promises'
import { URL } from 'node:url'

/**
 * Parses an IPv4 or IPv6 string into a BigInt and address metadata.
 * Strips square brackets and zone IDs.
 */
export function parseIp(ipString) {
  if (typeof ipString !== 'string') return null
  const cleaned = ipString.trim().replace(/^\[|\]$/g, '').split('%')[0]

  // Check IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleaned)) {
    const octets = cleaned.split('.').map(Number)
    if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return null
    const val = (BigInt(octets[0]) << 24n) |
      (BigInt(octets[1]) << 16n) |
      (BigInt(octets[2]) << 8n) |
      BigInt(octets[3])
    return { version: 4, val, canonical: octets.join('.') }
  }

  // Check IPv6
  if (!cleaned.includes(':')) return null

  let full = cleaned
  // Handle IPv4-mapped IPv6 suffix: e.g. ::ffff:192.0.2.1
  const lastColon = full.lastIndexOf(':')
  const potentialIpv4 = full.slice(lastColon + 1)
  if (potentialIpv4.includes('.')) {
    const ipv4Parsed = parseIp(potentialIpv4)
    if (!ipv4Parsed || ipv4Parsed.version !== 4) return null
    const hex1 = ((ipv4Parsed.val >> 16n) & 0xffffn).toString(16)
    const hex2 = (ipv4Parsed.val & 0xffffn).toString(16)
    full = `${full.slice(0, lastColon)}:${hex1}:${hex2}`
  }

  if (full.includes('::')) {
    const parts = full.split('::')
    if (parts.length > 2) return null // Multiple :: is invalid
    const left = parts[0] ? parts[0].split(':') : []
    const right = parts[1] ? parts[1].split(':') : []
    const missing = 8 - (left.length + right.length)
    if (missing < 1) return null
    const middle = Array(missing).fill('0')
    full = [...left, ...middle, ...right].join(':')
  }

  const groups = full.split(':')
  if (groups.length !== 8) return null

  let val = 0n
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    val = (val << 16n) | BigInt(parseInt(group, 16))
  }

  return { version: 6, val, canonical: cleaned.toLowerCase() }
}

/**
 * Helper to build CIDR range matcher
 */
function ipv4Cidr(cidrStr) {
  const [base, bitsStr] = cidrStr.split('/')
  const bits = Number(bitsStr)
  const parsed = parseIp(base)
  const mask = bits === 0 ? 0n : ((1n << 32n) - 1n) ^ ((1n << (32n - BigInt(bits))) - 1n)
  const start = parsed.val & mask
  return {
    version: 4,
    cidr: cidrStr,
    matches: (ipVal) => (ipVal & mask) === start,
  }
}

function ipv6Cidr(cidrStr) {
  const [base, bitsStr] = cidrStr.split('/')
  const bits = Number(bitsStr)
  const parsed = parseIp(base)
  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << (128n - BigInt(bits))) - 1n)
  const start = parsed.val & mask
  return {
    version: 6,
    cidr: cidrStr,
    matches: (ipVal) => (ipVal & mask) === start,
  }
}

const BLOCKED_IPV4_RANGES = [
  ipv4Cidr('0.0.0.0/8'), // Current network / broadcast
  ipv4Cidr('10.0.0.0/8'), // RFC 1918 Private
  ipv4Cidr('100.64.0.0/10'), // RFC 6598 Carrier-Grade NAT
  ipv4Cidr('127.0.0.0/8'), // RFC 1122 Loopback
  ipv4Cidr('169.254.0.0/16'), // RFC 3927 Link-Local (Cloud metadata)
  ipv4Cidr('172.16.0.0/12'), // RFC 1918 Private
  ipv4Cidr('192.0.0.0/24'), // RFC 6890 IETF Protocol Assignments
  ipv4Cidr('192.0.2.0/24'), // RFC 5737 TEST-NET-1
  ipv4Cidr('192.88.99.0/24'), // RFC 7526 6to4 Relay Anycast
  ipv4Cidr('192.168.0.0/16'), // RFC 1918 Private
  ipv4Cidr('198.18.0.0/15'), // RFC 2544 Benchmarking
  ipv4Cidr('198.51.100.0/24'), // RFC 5737 TEST-NET-2
  ipv4Cidr('203.0.113.0/24'), // RFC 5737 TEST-NET-3
  ipv4Cidr('224.0.0.0/4'), // RFC 5771 Multicast
  ipv4Cidr('240.0.0.0/4'), // RFC 1112 Reserved
  ipv4Cidr('255.255.255.255/32'), // Limited Broadcast
]

const BLOCKED_IPV6_RANGES = [
  ipv6Cidr('::/128'), // Unspecified
  ipv6Cidr('::1/128'), // Loopback
  ipv6Cidr('100::/64'), // Discard-only
  ipv6Cidr('2001::/23'), // IETF Protocol
  ipv6Cidr('2001:db8::/32'), // Documentation
  ipv6Cidr('fc00::/7'), // Unique Local Address (ULA)
  ipv6Cidr('fe80::/10'), // Link-Local Unicast
  ipv6Cidr('fec0::/10'), // Site-Local (deprecated)
  ipv6Cidr('ff00::/8'), // Multicast
]

// IPv6 ranges that embed an IPv4 address
const IPV4_MAPPED_IPV6_MASK = ipv6Cidr('::ffff:0:0/96')
const IPV4_TRANSLATED_IPV6_MASK = ipv6Cidr('64:ff9b::/96')
const IPV6_6TO4_MASK = ipv6Cidr('2002::/16')
const IPV6_GLOBAL_UNICAST = ipv6Cidr('2000::/3')

/**
 * Checks whether an IP address is private, loopback, link-local, reserved, or prohibited.
 * Returns { blocked: boolean, reason?: string, canonical?: string }
 */
export function isPrivateOrBlockedIp(ipString) {
  const parsed = parseIp(ipString)
  if (!parsed) {
    return { blocked: true, reason: 'Invalid or unparseable IP address.' }
  }

  if (parsed.version === 4) {
    for (const range of BLOCKED_IPV4_RANGES) {
      if (range.matches(parsed.val)) {
        return { blocked: true, reason: `IPv4 address is in prohibited range (${range.cidr}).`, canonical: parsed.canonical }
      }
    }
    return { blocked: false, canonical: parsed.canonical }
  }

  if (parsed.version === 6) {
    // Check if it's an IPv4-mapped or translated IPv6 address
    if (IPV4_MAPPED_IPV6_MASK.matches(parsed.val) || IPV4_TRANSLATED_IPV6_MASK.matches(parsed.val)) {
      const embeddedIpv4Val = parsed.val & 0xffffffffn
      for (const range of BLOCKED_IPV4_RANGES) {
        if (range.matches(embeddedIpv4Val)) {
          return {
            blocked: true,
            reason: `Embedded IPv4 in IPv6 is in prohibited range (${range.cidr}).`,
            canonical: parsed.canonical,
          }
        }
      }
      return { blocked: false, canonical: parsed.canonical }
    }

    // Check 6to4 (2002::/16) where bits 16..47 are IPv4
    if (IPV6_6TO4_MASK.matches(parsed.val)) {
      const embeddedIpv4Val = (parsed.val >> 80n) & 0xffffffffn
      for (const range of BLOCKED_IPV4_RANGES) {
        if (range.matches(embeddedIpv4Val)) {
          return {
            blocked: true,
            reason: `Embedded 6to4 IPv4 is in prohibited range (${range.cidr}).`,
            canonical: parsed.canonical,
          }
        }
      }
      return { blocked: false, canonical: parsed.canonical }
    }

    // Check standard IPv6 blocked ranges
    for (const range of BLOCKED_IPV6_RANGES) {
      if (range.matches(parsed.val)) {
        return { blocked: true, reason: `IPv6 address is in prohibited range (${range.cidr}).`, canonical: parsed.canonical }
      }
    }

    if (!IPV6_GLOBAL_UNICAST.matches(parsed.val)) {
      return { blocked: true, reason: 'IPv6 address is outside global unicast space.', canonical: parsed.canonical }
    }

    return { blocked: false, canonical: parsed.canonical }
  }

  return { blocked: true, reason: 'Unsupported IP version.' }
}

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /\.home$/i,
  /\.corp$/i,
  /^metadata\.google\.internal$/i,
  /^instance-data$/i,
  /^metadata\.azure\.com$/i,
]

/**
 * Checks if a hostname by itself is prohibited (e.g. localhost, cloud metadata name).
 */
export function isBlockedHostname(hostname) {
  if (typeof hostname !== 'string' || !hostname.trim()) return true
  const lower = hostname.trim().toLowerCase()
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(lower)) return true
  }
  return false
}

/**
 * Verifies that a target hostname is within the allowed application scope.
 * Scope rule: The target host must equal the allowed host, or be a valid subdomain of it.
 * Suffix matching like "badexample.com" when allowed is "example.com" is strictly rejected.
 */
export function isHostInScope(targetHost, allowedBaseHost) {
  if (!targetHost || !allowedBaseHost) return false
  const target = targetHost.toLowerCase().trim()
  const base = allowedBaseHost.toLowerCase().trim()

  if (target === base) return true
  if (target.endsWith(`.${base}`)) return true
  return false
}

export function normalizeAllowedOrigin(value) {
  let url
  try { url = new URL(String(value)) } catch { throw new Error('Allowed origin must be a valid HTTP or HTTPS origin.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Allowed origin must contain only an HTTP or HTTPS origin (scheme, host, and optional standard port).')
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (!['80', '443'].includes(port)) throw new Error('Only standard web ports 80 and 443 can be approved.')
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!hostname || isBlockedHostname(hostname)) throw new Error('This hostname cannot be approved.')
  if (net.isIP(hostname.replace(/^\[|\]$/g, '')) && isPrivateOrBlockedIp(hostname).blocked) throw new Error('A private or prohibited IP address cannot be approved.')
  return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`
}

/** Permit only a form POST to a rendered same-origin login action during the manual auth gate. */
export function isManualLoginPostAllowed({ method, targetUrl, contentType, manualAuthOrigin, manualAuthPaths, isManualAuthActive }) {
  if (method !== 'POST' || typeof manualAuthOrigin !== 'string' || typeof isManualAuthActive !== 'function' || !isManualAuthActive()) return false
  let target
  let loginOrigin
  try {
    target = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl))
    loginOrigin = normalizeAllowedOrigin(manualAuthOrigin)
  } catch {
    return false
  }
  if (!originAllowed(target, new Set([loginOrigin]))) return false
  if (!(manualAuthPaths instanceof Set) || !manualAuthPaths.has(target.pathname)) return false
  return /^application\/(x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(String(contentType || ''))
}

/** Permit a write only during its approved form-submit action and only to that form's exact primary-origin path. */
export function isApprovedWritePostAllowed({ method, targetUrl, contentType, authorization }) {
  if (method !== 'POST' || !authorization || !['create', 'update', 'delete'].includes(authorization.operation)) return false
  let target
  let approvedOrigin
  try {
    target = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl))
    approvedOrigin = normalizeAllowedOrigin(authorization.origin)
  } catch {
    return false
  }
  if (!originAllowed(target, new Set([approvedOrigin])) || target.pathname !== authorization.path) return false
  return /^application\/(x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(String(contentType || ''))
}

function originAllowed(url, origins) {
  try { return origins.has(normalizeAllowedOrigin(url.origin)) } catch { return false }
}

function safeAuditUrl(raw) {
  try {
    const url = new URL(raw)
    return { hostname: url.hostname.toLowerCase().replace(/\.$/, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }
  } catch { return { hostname: null, port: null } }
}

/**
 * Resolves a hostname via DNS and strictly validates ALL returned IP addresses.
 * If ANY returned IP is non-public or prohibited, the resolution is rejected.
 *
 * @param {string} hostname
 * @param {object} [options]
 * @param {function} [options.dnsLookup] - Optional custom DNS lookup function for testing.
 * @returns {Promise<{ hostname: string, pinnedIp: string, allIps: string[] }>}
 */
export async function resolveAndValidateHost(hostname, options = {}) {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')

  if (isBlockedHostname(host)) {
    throw new Error(`Access to blocked host "${host}" is prohibited by security policy.`)
  }

  // If the host is already an IP address string
  if (net.isIP(host)) {
    const ipCheck = isPrivateOrBlockedIp(host)
    if (ipCheck.blocked) {
      throw new Error(`Direct connection to prohibited IP address (${host}) is denied: ${ipCheck.reason}`)
    }
    return { hostname: host, pinnedIp: ipCheck.canonical, allIps: [ipCheck.canonical] }
  }

  const lookupFn = options.dnsLookup || dns.lookup
  let addresses
  try {
    addresses = await lookupFn(host, { all: true })
  } catch (err) {
    throw new Error(`DNS resolution failed for "${host}": ${err.message}`)
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS resolution returned no addresses for "${host}".`)
  }

  const validatedIps = []
  for (const entry of addresses) {
    const ip = entry.address
    const check = isPrivateOrBlockedIp(ip)
    if (check.blocked) {
      throw new Error(`DNS answer for "${host}" returned prohibited IP ${ip}: ${check.reason}`)
    }
    validatedIps.push(check.canonical || ip)
  }

  // Return the first validated IP as the pinned IP
  return {
    hostname: host,
    pinnedIp: validatedIps[0],
    allIps: validatedIps,
  }
}

function classifyDestinationError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  if (message.includes('dns resolution failed') || message.includes('no addresses')) return 'DNS_VALIDATION_FAILED'
  if (message.includes('blocked host')) return 'BLOCKED_HOSTNAME'
  if (message.includes('prohibited ip') || message.includes('prohibited range') || message.includes('dns answer')) return 'PRIVATE_IP_BLOCKED'
  return 'DNS_VALIDATION_FAILED'
}

function safeDestinationFailureReason(outcome) {
  if (outcome === 'DNS_VALIDATION_FAILED') return 'DNS resolution failed or returned no usable addresses.'
  if (outcome === 'BLOCKED_HOSTNAME') return 'Destination hostname is prohibited by the outbound security policy.'
  if (outcome === 'PRIVATE_IP_BLOCKED') return 'A resolved destination address is in a prohibited network range.'
  return 'Destination validation failed.'
}

/**
 * Creates an egress security proxy instance that enforces strict destination and IP policies.
 *
 * All traffic from the browser must pass through this proxy.
 * - HTTP CONNECT (for HTTPS): Pins resolved public IP, verifies scope and port (443 only), connects directly to pinned IP.
 * - HTTP GET/POST: Pins resolved public IP, verifies scope and port (80 only), proxies to pinned IP.
 * - Any prohibited IP, blocked host, unapproved scope, or non-standard port is dropped immediately.
 *
 * @param {object} config
 * @param {string} config.allowedHost - The registered host permitted for this exploration session.
 * @param {number} [config.connectTimeoutMs=8000] - Socket connection timeout.
 * @param {function} [config.dnsLookup] - Injected DNS lookup for test fixtures.
 * @param {function} [config.onSecurityViolation] - Callback for audit logging.
 */
export async function createSecurityProxy(config) {
  const {
    allowedHost,
    primaryOrigin = `https://${allowedHost}`,
    resourceOrigins = [],
    navigationOrigins = [],
    connectTimeoutMs = 8000,
    dnsLookup,
    onSecurityViolation,
    testTargetIp,
    testTargetPort,
    manualAuthOrigin,
    manualAuthPaths,
    isManualAuthActive = () => false,
    isApprovedWriteRequest = () => false,
  } = config

  if (!allowedHost) {
    throw new Error('allowedHost is required to start a security proxy.')
  }

  const allowedResourceOrigins = new Set([normalizeAllowedOrigin(primaryOrigin), ...resourceOrigins.map(normalizeAllowedOrigin)])
  const allowedNavigation = new Set([normalizeAllowedOrigin(primaryOrigin), ...navigationOrigins.map(normalizeAllowedOrigin)])
  const allowedEgressOrigins = new Set([...allowedResourceOrigins, ...allowedNavigation])
  const audit = (type, url, details = {}) => {
    const safe = safeAuditUrl(url)
    onSecurityViolation?.({ type, ...safe, ...details })
  }

  const activeSockets = new Set()

  const server = http.createServer((req, res) => {
    // Handle standard HTTP requests
    let targetUrl
    try {
      targetUrl = new URL(req.url)
    } catch {
      audit('DNS_VALIDATION_FAILED', req.url, { reason: 'Malformed destination URL', category: 'unknown' })
      res.writeHead(400, { 'content-type': 'text/plain' })
      return res.end('Bad Request: Malformed destination URL.')
    }

    const manualLoginPost = isManualLoginPostAllowed({
      method: req.method,
      targetUrl,
      contentType: req.headers['content-type'],
      manualAuthOrigin,
      manualAuthPaths,
      isManualAuthActive,
    })
    const approvedWritePost = isApprovedWriteRequest({ method: req.method, targetUrl, contentType: req.headers['content-type'] }) === true
    if (req.method !== 'GET' && req.method !== 'HEAD' && !manualLoginPost && !approvedWritePost) {
      audit('OUT_OF_SCOPE', targetUrl.href, { category: 'unknown', reason: 'Read-only policy blocks non-GET/HEAD requests.' })
      res.writeHead(403, { 'content-type': 'text/plain' })
      return res.end('Forbidden by read-only policy.')
    }

    const targetPort = targetUrl.port ? Number(targetUrl.port) : (targetUrl.protocol === 'https:' ? 443 : 80)
    if (targetPort !== 80 && targetPort !== 443) {
      audit('PORT_BLOCKED', targetUrl.href, { category: 'unknown' })
      res.writeHead(403, { 'content-type': 'text/plain' })
      return res.end(`Forbidden: Port ${targetPort} is prohibited. Only standard web ports (80, 443) are allowed.`)
    }

    if (!originAllowed(targetUrl, allowedEgressOrigins)) {
      audit('OUT_OF_SCOPE', targetUrl.href, { category: 'unknown', explicitResourceEntryNeeded: true })
      res.writeHead(403, { 'content-type': 'text/plain' })
      return res.end(`Forbidden: Host "${targetUrl.hostname}" is out of registered scope for "${allowedHost}".`)
    }

    resolveAndValidateHost(targetUrl.hostname, { dnsLookup })
      .then(({ pinnedIp }) => {
        const destIp = testTargetIp || pinnedIp
        const destPort = testTargetPort || targetPort
        const proxyReq = http.request({
          host: destIp,
          port: destPort,
          method: req.method,
          path: targetUrl.pathname + targetUrl.search,
          headers: { ...req.headers, host: targetUrl.host },
          timeout: connectTimeoutMs,
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers)
          proxyRes.pipe(res)
        })

        proxyReq.on('timeout', () => {
          proxyReq.destroy()
          res.writeHead(504, { 'content-type': 'text/plain' })
          res.end('Gateway Timeout')
        })

        proxyReq.on('error', (err) => {
          audit('PROXY_FAILURE', targetUrl.href, { category: 'unknown', reason: 'Pinned destination connection failed.' })
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain' })
            res.end(`Bad Gateway: ${err.message}`)
          }
        })

        req.pipe(proxyReq)
      })
      .catch((err) => {
        const outcome = classifyDestinationError(err)
        audit(outcome, targetUrl.href, { stage: outcome === 'DNS_VALIDATION_FAILED' ? 'dns_validation' : 'destination_validation', category: 'unknown', reason: safeDestinationFailureReason(outcome) })
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end(`Forbidden: ${err.message}`)
      })
  })

  // Track client connections so we can close them cleanly
  server.on('connection', (socket) => {
    activeSockets.add(socket)
    socket.once('close', () => activeSockets.delete(socket))
  })

  // Handle HTTPS CONNECT tunneling
  server.on('connect', (req, clientSocket, head) => {
    activeSockets.add(clientSocket)
    clientSocket.once('close', () => activeSockets.delete(clientSocket))

    let connectUrl
    try { connectUrl = new URL(`https://${req.url}`) } catch { clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); clientSocket.destroy(); return }
    const targetHost = connectUrl.hostname.trim()
    const targetPort = Number(connectUrl.port || 443)

    if (targetPort !== 443 && targetPort !== 80) {
      audit('PORT_BLOCKED', `https://${targetHost}:${targetPort}`)
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.destroy()
      return
    }

    if (!originAllowed(new URL(`https://${targetHost}:${targetPort}`), allowedEgressOrigins)) {
      audit('OUT_OF_SCOPE', `https://${targetHost}:${targetPort}`, { category: 'unknown', explicitResourceEntryNeeded: true })
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.destroy()
      return
    }

    resolveAndValidateHost(targetHost, { dnsLookup })
      .then(({ pinnedIp }) => {
        // Connect directly to the PINNED validated IP address to prevent DNS rebinding
        const destIp = testTargetIp || pinnedIp
        const destPort = testTargetPort || targetPort
        const targetSocket = net.connect({
          host: destIp,
          port: destPort,
          timeout: connectTimeoutMs,
        }, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head && head.length > 0) {
            targetSocket.write(head)
          }
          targetSocket.pipe(clientSocket)
          clientSocket.pipe(targetSocket)
        })

        activeSockets.add(targetSocket)
        targetSocket.once('close', () => activeSockets.delete(targetSocket))

        targetSocket.on('timeout', () => {
          targetSocket.destroy()
          clientSocket.destroy()
        })

        targetSocket.on('error', () => {
          audit('PROXY_FAILURE', `https://${targetHost}:${targetPort}`, { category: 'unknown', reason: 'Pinned destination connection failed.' })
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          clientSocket.destroy()
        })

        clientSocket.on('error', () => {
          targetSocket.destroy()
        })
      })
      .catch((err) => {
        const outcome = classifyDestinationError(err)
        audit(outcome, `https://${targetHost}:${targetPort}`, { stage: outcome === 'DNS_VALIDATION_FAILED' ? 'dns_validation' : 'destination_validation', category: 'unknown', reason: safeDestinationFailureReason(outcome) })
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        clientSocket.destroy()
      })
  })

  // Start listening on loopback with an ephemeral port
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.once('error', reject)
  })

  const port = server.address().port
  const proxyUrl = `http://127.0.0.1:${port}`

  return {
    port,
    proxyUrl,
    allowedHost,
    primaryOrigin,
    allowedResourceOrigins: [...allowedResourceOrigins],
    allowedNavigationOrigins: [...allowedNavigation],
    close: async () => {
      for (const socket of activeSockets) {
        try {
          socket.destroy()
        } catch {}
      }
      activeSockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
