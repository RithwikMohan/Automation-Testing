import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setDatabasePoolForTesting } from './database.mjs'
import { classifyNavigationError, classifyNetworkFailure, runExploration } from './exploration/explorationRunner.mjs'
import { validateExplorationUrl, validateExplorationPayload } from './exploration/explorationValidation.mjs'
import { sanitizeExplorationUrl } from './exploration/explorationExtraction.mjs'

class TestMemoryPool {
  applications = new Map()
  explorations = new Map()

  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, ' ').trim()
    if (q.includes('FROM applications') && (q.includes('$1') || q.includes('a.id = $1'))) {
      const row = this.applications.get(params[0])
      return { rows: row ? [{ ...row, task_count: 0 }] : [] }
    }
    if (q.startsWith('INSERT INTO exploration_results')) {
      const [id, application_id, target_url, status, title, meta_description, headings, links, forms, interactive_elements, auth_detected, warnings, audit_summary, duration_ms, created_at] = params
      const row = {
        id,
        application_id,
        target_url,
        status,
        title,
        meta_description,
        headings: JSON.parse(headings),
        links: JSON.parse(links),
        forms: JSON.parse(forms),
        interactive_elements: JSON.parse(interactive_elements),
        auth_detected,
        warnings: JSON.parse(warnings),
        audit_summary: JSON.parse(audit_summary),
        duration_ms,
        created_at,
      }
      this.explorations.set(id, row)
      return { rows: [{ ...row }] }
    }
    if (q.startsWith('SELECT * FROM exploration_results WHERE application_id = $1')) {
      const rows = [...this.explorations.values()].filter((r) => r.application_id === params[0])
      return { rows }
    }
    if (q.startsWith('SELECT * FROM exploration_results WHERE id = $1')) {
      const row = this.explorations.get(params[0])
      return { rows: row ? [{ ...row }] : [] }
    }
    return { rows: [] }
  }
}

test('Validation rejects embedded credentials, unsupported schemes, and out-of-scope URLs', () => {
  const base = 'https://app.example.com'

  // Unsupported schemes
  assert.throws(() => validateExplorationUrl('ftp://app.example.com/file', base), /Unsupported scheme/)
  assert.throws(() => validateExplorationUrl('file:///etc/passwd', base), /Unsupported scheme/)
  assert.throws(() => validateExplorationUrl('javascript:alert(1)', base), /Unsupported scheme/)

  // Credentials
  assert.throws(() => validateExplorationUrl('https://admin:secret@app.example.com', base), /embedded credentials/)
  assert.throws(() => validateExplorationUrl('https://app.example.com?token=secret123', base), /credential or session query/)

  // Scope violations
  assert.throws(() => validateExplorationUrl('https://other.com/login', base), /not an approved navigation origin/)
  assert.throws(() => validateExplorationUrl('https://app.example.com.evil.com', base), /not an approved navigation origin/)

  // Valid same-origin and subdomain paths
  const valid = validateExplorationUrl('https://app.example.com/dashboard?view=grid', base)
  assert.equal(valid.hostname, 'app.example.com')
  assert.equal(valid.normalizedUrl, 'https://app.example.com/dashboard?view=grid')
})

test('Navigation approval is separate from resource approval', () => {
  const base = 'https://app.example.com'
  assert.throws(() => validateExplorationUrl('https://login.identity.example/auth', base), /not an approved navigation origin/)
  const approved = validateExplorationUrl('https://login.identity.example/auth', base, ['https://login.identity.example'])
  assert.equal(approved.origin, 'https://login.identity.example')
  assert.throws(() => validateExplorationUrl('https://static.example-cdn.test', base), /not an approved navigation origin/)
})

test('Exploration URLs redact credential-like query parameters before results are stored', () => {
  const safe = sanitizeExplorationUrl('https://portal.example.com/path?view=grid&access_token=secret&sessionid=private')
  assert.match(safe, /view=grid/)
  assert.doesNotMatch(safe, /secret|private/)
  assert.match(safe, /access_token=%5Bredacted%5D/)
})

test('Validation rejects archived applications and malformed payloads', () => {
  assert.throws(
    () => validateExplorationPayload(null, { id: 'app-1', status: 'Active', base_url: 'https://example.com' }),
    /payload must be an object/
  )
  assert.throws(
    () => validateExplorationPayload({}, null),
    /Registered application not found/
  )
  assert.throws(
    () => validateExplorationPayload({}, { id: 'app-1', status: 'Archived', base_url: 'https://example.com' }),
    /Cannot explore an archived application/
  )
})

test('Transport failures retain their cause and client-side policy aborts remain security blocks', () => {
  assert.equal(classifyNavigationError(new Error('net::ERR_PROXY_CONNECTION_FAILED')), 'FAILED')
  assert.equal(classifyNavigationError(new Error('net::ERR_TUNNEL_CONNECTION_FAILED')), 'FAILED')
  assert.equal(classifyNavigationError(new Error('net::ERR_BLOCKED_BY_CLIENT')), 'SECURITY_BLOCKED')
  assert.equal(classifyNavigationError(new Error('HTTP 403')), 'FAILED')
  assert.equal(classifyNavigationError(new Error('Navigation timeout of 2000 ms exceeded')), 'TIMEOUT')
  assert.equal(classifyNavigationError(new Error('Unexpected page crash')), null)
})

test('Network audit distinguishes proxy startup, proxy connection, DNS, and TLS failures', () => {
  assert.equal(classifyNetworkFailure(new Error('listen failed'), 'proxy-startup'), 'PROXY_FAILURE')
  assert.equal(classifyNetworkFailure(new Error('net::ERR_PROXY_CONNECTION_FAILED')), 'PROXY_FAILURE')
  assert.equal(classifyNetworkFailure(new Error('ENOTFOUND host')), 'DNS_VALIDATION_FAILED')
  assert.equal(classifyNetworkFailure(new Error('net::ERR_CERT_AUTHORITY_INVALID')), 'TLS_VALIDATION_FAILED')
})

test('A remote HTTP 403 is not mislabeled as a Chronos security block', async () => {
  const remote = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Access Denied</title><h1>Access Denied</h1>')
  })
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve))
  const port = remote.address().port
  const mockPool = new TestMemoryPool()
  setDatabasePoolForTesting(mockPool)
  const app = { id: 'app-remote-403-test', name: 'Remote 403', base_url: 'http://hcm.fixture.test', status: 'Active' }
  mockPool.applications.set(app.id, app)
  try {
    const result = await runExploration({ applicationId: app.id, timeoutMs: 3000 }, {
      dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
      testTargetIp: '127.0.0.1',
      testTargetPort: port,
      persist: false,
    })
    assert.equal(result.status, 'FAILED')
    assert.equal(result.auditSummary.mainDocumentStatus, 403)
    assert.equal(result.auditSummary.blockedResources, 0)
    assert.equal(result.auditSummary.blockedByReason.REMOTE_HTTP_ERROR, 1)
    const diagnostic = result.warnings.find((item) => item.reasonCode === 'HTTP_403')
    assert.equal(diagnostic.stage, 'remote_response')
    assert.equal(diagnostic.topLevelNavigation, true)
    assert.equal(diagnostic.hostname, 'hcm.fixture.test')
    assert.match(diagnostic.explanation, /Chronos did not block/)
  } finally {
    await new Promise((resolve) => remote.close(resolve))
  }
})

test('Read-only exploration navigates permitted destination and extracts structured data', async () => {
  const mockPool = new TestMemoryPool()
  setDatabasePoolForTesting(mockPool)

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Portal Dashboard</title>
          <meta name="description" content="Secure internal dashboard for tests">
        </head>
        <body>
          <h1>Main Portal</h1>
          <h2>Section One</h2>
          <p>Welcome to the portal.</p>
          <a href="/docs">Documentation</a>
          <a href="https://external.com/faq">FAQ</a>
          <button id="btn-action">Click Me</button>
          <form action="/search" method="GET">
            <input type="text" name="q" placeholder="Search keywords">
            <input type="submit" value="Search">
          </form>
        </body>
      </html>
    `)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const serverPort = server.address().port

  // Register application
  const app = {
    id: 'app-valid-1',
    name: 'Test Portal',
    base_url: 'http://test-portal.example.com',
    status: 'Active',
  }
  mockPool.applications.set(app.id, app)

  // Injected DNS mapping: maps test-portal.example.com to public IP for validation,
  // but for local test execution connects to our loopback server
  const testDns = async (host) => {
    if (host === 'test-portal.example.com') {
      return [{ address: '127.0.0.1', family: 4 }]
    }
    return [{ address: '127.0.0.1', family: 4 }]
  }

  // To allow the test proxy to communicate with our loopback test fixture,
  // we pass an allowedHost and test-friendly DNS while testing the full extraction engine
  try {
    const result = await runExploration({
      applicationId: app.id,
      targetUrl: 'http://test-portal.example.com/',
      timeoutMs: 8000,
    }, {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      testTargetIp: '127.0.0.1',
      testTargetPort: serverPort,
      persist: true,
    })

    assert.equal(result.status, 'SUCCESS')
    assert.equal(result.title, 'Test Portal Dashboard')
    assert.equal(result.metaDescription, 'Secure internal dashboard for tests')
    assert.ok(result.headings.length >= 2)
    assert.equal(result.headings[0].text, 'Main Portal')
    assert.ok(result.links.length >= 2)
    assert.ok(result.forms.length >= 1)
    assert.equal(result.forms[0].action, '/search')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Explicit authentication navigation origin works while resource approval stays separate', async () => {
  const mockPool = new TestMemoryPool()
  setDatabasePoolForTesting(mockPool)
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Identity Portal</title><h1>Sign in</h1>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const app = {
    id: 'app-auth-origin-test', name: 'Federated Portal', base_url: 'http://app.example.com', status: 'Active',
    approved_resource_origins: ['http://static.example.net'],
    approved_navigation_origins: ['http://login.identity.example'],
  }
  mockPool.applications.set(app.id, app)
  try {
    const result = await runExploration({ applicationId: app.id, targetUrl: 'http://login.identity.example/auth' }, {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      testTargetIp: '127.0.0.1',
      testTargetPort: server.address().port,
      persist: false,
    })
    assert.equal(result.status, 'SUCCESS')
    assert.equal(result.title, 'Identity Portal')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Redirect to prohibited host is blocked and prohibited endpoint receives zero requests', async () => {
  let prohibitedHits = 0
  const prohibitedServer = http.createServer((_req, res) => {
    prohibitedHits++
    res.writeHead(200)
    res.end('TOP SECRET SENSITIVE DATA')
  })
  await new Promise((resolve) => prohibitedServer.listen(0, '127.0.0.1', resolve))
  const prohibitedPort = prohibitedServer.address().port

  const allowedServer = http.createServer((_req, res) => {
    // Attempt malicious redirect to loopback sensitive server
    res.writeHead(302, {
      Location: `http://127.0.0.1:${prohibitedPort}/secret`,
    })
    res.end()
  })
  await new Promise((resolve) => allowedServer.listen(0, '127.0.0.1', resolve))
  const allowedPort = allowedServer.address().port

  const mockPool = new TestMemoryPool()
  setDatabasePoolForTesting(mockPool)

  const app = {
    id: 'app-redirect-test',
    name: 'Redirecting App',
    base_url: 'http://redirect.example.com',
    status: 'Active',
  }
  mockPool.applications.set(app.id, app)

  try {
    const result = await runExploration({
      applicationId: app.id,
      targetUrl: 'http://redirect.example.com/',
      timeoutMs: 5000,
    }, {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      testTargetIp: '127.0.0.1',
      testTargetPort: allowedPort,
      persist: true,
    })

    // CRITICAL SECURITY ASSERTION:
    // The prohibited server must NEVER have been contacted
    assert.equal(prohibitedHits, 0, 'Prohibited endpoint must receive exactly zero requests')
    assert.ok(['SECURITY_BLOCKED', 'FAILED', 'PARTIAL'].includes(result.status))
    assert.ok(result.warnings.some((item) => typeof item !== 'string' && ['OUT_OF_SCOPE', 'REDIRECT_BLOCKED'].includes(item.outcome)))
  } finally {
    await new Promise((resolve) => allowedServer.close(resolve))
    await new Promise((resolve) => prohibitedServer.close(resolve))
  }
})

test('Unsafe iframes and subresources pointing to prohibited hosts are blocked', async () => {
  let prohibitedHits = 0
  const prohibitedServer = http.createServer((_req, res) => {
    prohibitedHits++
    res.writeHead(200)
    res.end('Prohibited subresource')
  })
  await new Promise((resolve) => prohibitedServer.listen(0, '127.0.0.1', resolve))
  const prohibitedPort = prohibitedServer.address().port

  const allowedServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`
      <!DOCTYPE html>
      <html>
        <body>
          <h1>Parent Page</h1>
          <iframe src="http://127.0.0.1:${prohibitedPort}/secret-frame"></iframe>
          <img src="http://127.0.0.1:${prohibitedPort}/tracking-pixel.png" />
        </body>
      </html>
    `)
  })
  await new Promise((resolve) => allowedServer.listen(0, '127.0.0.1', resolve))
  const allowedPort = allowedServer.address().port

  const mockPool = new TestMemoryPool()
  setDatabasePoolForTesting(mockPool)

  const app = {
    id: 'app-subresource-test',
    name: 'Subresource App',
    base_url: 'http://app.example.com',
    status: 'Active',
  }
  mockPool.applications.set(app.id, app)

  try {
    const result = await runExploration({
      applicationId: app.id,
      targetUrl: 'http://app.example.com/',
      timeoutMs: 5000,
    }, {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      testTargetIp: '127.0.0.1',
      testTargetPort: allowedPort,
      persist: true,
    })

    // The prohibited subresource endpoint must NEVER have received any requests
    assert.equal(prohibitedHits, 0, 'Prohibited server must receive zero subresource requests')
    assert.ok(result.warnings.some((w) => typeof w !== 'string' && ['OUT_OF_SCOPE', 'PORT_BLOCKED', 'PRIVATE_IP_BLOCKED'].includes(w.outcome)))
  } finally {
    await new Promise((resolve) => allowedServer.close(resolve))
    await new Promise((resolve) => prohibitedServer.close(resolve))
  }
})

test('Prohibited documentation IP is blocked by security boundary', async () => {
  const mockPool = new TestMemoryPool()
  setDatabasePoolForTesting(mockPool)

  const app = {
    id: 'app-blocked-ip-test',
    name: 'Blocked IP App',
    base_url: 'http://blocked.example.com',
    status: 'Active',
  }
  mockPool.applications.set(app.id, app)

  const result = await runExploration({
    applicationId: app.id,
    targetUrl: 'http://blocked.example.com',
    timeoutMs: 3000,
  }, {
    // Non-routable documentation IP that must be blocked
    dnsLookup: async () => [{ address: '198.51.100.1', family: 4 }],
    persist: false,
  })

  assert.equal(result.status, 'SECURITY_BLOCKED')
  const blocked = result.warnings.find((w) => typeof w !== 'string' && w.outcome === 'PRIVATE_IP_BLOCKED')
  assert.ok(blocked)
  assert.equal(blocked.reasonCode, 'PRIVATE_IP_BLOCKED')
  assert.equal(blocked.stage, 'destination_validation')
  assert.equal(blocked.hostname, 'blocked.example.com')
  assert.equal(blocked.topLevelNavigation, true)
  assert.match(blocked.recommendedAction, /public destination/)
})

test('Slow server exceeding timeout is cleanly aborted without leaking resources', async () => {
  const hangingServer = http.createServer((_req, _res) => {
    // Intentionally never respond to simulate timeout
  })
  await new Promise((resolve) => hangingServer.listen(0, '127.0.0.1', resolve))
  const hangingPort = hangingServer.address().port

  const mockPool = new TestMemoryPool()
  setDatabasePoolForTesting(mockPool)

  const app = {
    id: 'app-timeout-test',
    name: 'Slow App',
    base_url: 'http://slow.example.com',
    status: 'Active',
  }
  mockPool.applications.set(app.id, app)

  try {
    const result = await runExploration({
      applicationId: app.id,
      targetUrl: 'http://slow.example.com/',
      timeoutMs: 2000,
    }, {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      testTargetIp: '127.0.0.1',
      testTargetPort: hangingPort,
      persist: false,
    })

    assert.equal(result.status, 'TIMEOUT')
    assert.ok(result.durationMs >= 0)
  } finally {
    await new Promise((resolve) => hangingServer.close(resolve))
  }
})

