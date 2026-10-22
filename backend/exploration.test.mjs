import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setDatabasePoolForTesting } from './database.mjs'
import { classifyNavigationError, runExploration } from './exploration/explorationRunner.mjs'
import { validateExplorationUrl, validateExplorationPayload } from './exploration/explorationValidation.mjs'

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
      const [id, application_id, target_url, status, title, meta_description, headings, links, forms, interactive_elements, auth_detected, warnings, duration_ms, created_at] = params
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
  assert.throws(() => validateExplorationUrl('https://other.com/login', base), /out of registered scope/)
  assert.throws(() => validateExplorationUrl('https://app.example.com.evil.com', base), /out of registered scope/)

  // Valid same-origin and subdomain paths
  const valid = validateExplorationUrl('https://app.example.com/dashboard?view=grid', base)
  assert.equal(valid.hostname, 'app.example.com')
  assert.equal(valid.normalizedUrl, 'https://app.example.com/dashboard?view=grid')
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

test('Proxy connection failures fail closed as security blocked and timeouts remain timeouts', () => {
  assert.equal(classifyNavigationError(new Error('net::ERR_PROXY_CONNECTION_FAILED')), 'SECURITY_BLOCKED')
  assert.equal(classifyNavigationError(new Error('net::ERR_TUNNEL_CONNECTION_FAILED')), 'SECURITY_BLOCKED')
  assert.equal(classifyNavigationError(new Error('Navigation timeout of 2000 ms exceeded')), 'TIMEOUT')
  assert.equal(classifyNavigationError(new Error('Unexpected page crash')), null)
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
    assert.ok(result.status === 'SECURITY_BLOCKED' || result.status === 'FAILED')
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
    assert.ok(result.warnings.some((w) => w.includes('Blocked') || w.includes('security boundary')))
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
  assert.ok(result.warnings.some((w) => w.includes('security boundary') || w.includes('prohibited')))
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

