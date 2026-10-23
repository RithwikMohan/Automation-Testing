import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { isAuthorizedHrRequest, isRegisteredHcmApp } from './hrAccess.mjs'
import { captureHcmInspection, closeHcmInspection, getHcmInspectionState, resumeHcmInspection, startHcmInspection } from './inspection.mjs'

test('HR routes fail closed unless a configured high entropy token matches', () => {
  const token = 'a'.repeat(48)
  assert.equal(isAuthorizedHrRequest(token, token), true)
  assert.equal(isAuthorizedHrRequest('wrong', token), false)
  assert.equal(isAuthorizedHrRequest(token, ''), false)
  assert.equal(isAuthorizedHrRequest(token, 'short'), false)
  assert.equal(isAuthorizedHrRequest(undefined, token), false)
})

test('inspection accepts only active manually authenticated registration of the target HCM origin', () => {
  const base = { status: 'Active', auth_method: 'manual', base_url: 'https://fa-erzp-dev26-saasfademo1.ds-fa.oraclepdemos.com' }
  assert.equal(isRegisteredHcmApp(base), true)
  assert.equal(isRegisteredHcmApp({ ...base, auth_method: 'none' }), false)
  assert.equal(isRegisteredHcmApp({ ...base, base_url: 'https://evil-fa-erzp-dev26-saasfademo1.ds-fa.oraclepdemos.com' }), false)
})

test('manual inspection captures redacted wizard structure and blocks business POST after login', async () => {
  let loginPosts = 0
  let businessPosts = 0
  const server = http.createServer(async (request, response) => {
    if (request.url === '/login' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><form method="post" action="/auth"><label for="pw">Password</label><input id="pw" type="password"><button type="submit">Sign In</button></form>')
      return
    }
    if (request.url === '/auth' && request.method === 'POST') {
      loginPosts += 1
      for await (const _chunk of request) {}
      response.writeHead(303, { location: '/hiring', 'content-type': 'text/plain' })
      response.end('')
      return
    }
    if (request.url === '/business' && request.method === 'POST') {
      businessPosts += 1
      response.writeHead(200).end('must not reach')
      return
    }
    if (request.url === '/hiring') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><main><h1>Hire an employee</h1><h2>Personal Details</h2><form>
        <label for="first">First Name</label><input id="first" value="Sensitive Person">
        <label for="email">Work Email</label><input id="email" value="private@example.test">
        <label for="legal">Legal Employer</label><select id="legal"><option>Choose</option><option>Example Legal Employer</option></select>
        <div role="alert">Hire date is required.</div><button type="button">Continue</button></form>
        <button type="button" onclick="fetch('/business',{method:'POST'})">Create Employee</button></main>`)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let page
  let session
  const lifecycle = []
  try {
    session = await startHcmInspection({
      status: 'Active', auth_method: 'manual', base_url: 'http://browser-test.fixture',
      login_url: 'http://browser-test.fixture/login', approved_navigation_origins: [], approved_resource_origins: [],
    }, {
      headless: true,
      dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
      testTargetIp: '127.0.0.1', testTargetPort: server.address().port,
      onPageReady: (value) => { page = value },
      onLifecycle: (event) => lifecycle.push(event),
    })
    assert.equal(session.state, 'WAITING_FOR_MANUAL_LOGIN')
    assert.equal(page.isClosed(), false, 'page must remain open after the session creation call returns')
    assert.equal(getHcmInspectionState(session.id).state, 'WAITING_FOR_MANUAL_LOGIN')
    assert.ok(lifecycle.some((event) => event.event === 'session_ready'))
    await assert.rejects(startHcmInspection({ status: 'Active', auth_method: 'manual', base_url: 'http://browser-test.fixture', login_url: 'http://browser-test.fixture/login', approved_navigation_origins: [], approved_resource_origins: [] }, { headless: true }), /already active/)
    assert.equal(await captureHcmInspection(session.id), null)
    assert.equal(await resumeHcmInspection(session.id), false)
    await page.evaluate(() => fetch('/business', { method: 'POST' }).catch(() => null))
    assert.equal(businessPosts, 0)
    await page.getByLabel('Password').fill('mock-only-password')
    await page.getByRole('button', { name: 'Sign In' }).click()
    assert.equal(loginPosts, 1)
    assert.equal(await resumeHcmInspection(session.id), true)
    const withEnteredData = await captureHcmInspection(session.id)
    assert.equal(withEnteredData.snapshot.ready, false)
    assert.match(withEnteredData.snapshot.message, /withheld/)
    assert.doesNotMatch(JSON.stringify(withEnteredData), /Sensitive Person|private@example\.test/)
    await page.locator('#first').fill('')
    await page.locator('#email').fill('')
    const captured = await captureHcmInspection(session.id)
    assert.equal(captured.state, 'AUTHENTICATED_READ_ONLY')
    assert.equal(captured.snapshot.ready, true)
    assert.ok(captured.snapshot.fields.some((field) => field.label === 'Legal Employer' && field.options.includes('Example Legal Employer')))
    assert.ok(captured.snapshot.validationMessages.some((message) => message === 'Hire date is required.'))
    const serialized = JSON.stringify(captured)
    assert.doesNotMatch(serialized, /Sensitive Person|private@example\.test|mock-only-password/)
    await page.getByRole('button', { name: 'Create Employee' }).click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(businessPosts, 0)
    assert.equal(await closeHcmInspection(session.id), true)
    assert.equal(page.isClosed(), true)
    assert.equal(await captureHcmInspection(session.id), null)
  } finally {
    if (session) await closeHcmInspection(session.id)
    await new Promise((resolve) => server.close(resolve))
  }
})
test('default inspection browser is headed and stays connected after session creation returns', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<form method="post" action="/auth"><input type="password"></form>')
    } else response.writeHead(200).end('')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const lifecycle = []
  let session
  let page
  let browser
  try {
    session = await startHcmInspection({
      status: 'Active', auth_method: 'manual', base_url: 'http://browser-test.fixture',
      login_url: 'http://browser-test.fixture/login', approved_navigation_origins: [], approved_resource_origins: [],
    }, {
      dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
      testTargetIp: '127.0.0.1', testTargetPort: server.address().port,
      onPageReady: (value) => { page = value },
      onBrowserReady: (value) => { browser = value },
      onLifecycle: (event) => lifecycle.push(event),
    })
    assert.equal(lifecycle.find((event) => event.event === 'browser_started').headless, false)
    assert.equal(browser.isConnected(), true)
    assert.equal(page.isClosed(), false)
    assert.equal(getHcmInspectionState(session.id).state, 'WAITING_FOR_MANUAL_LOGIN')
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(browser.isConnected(), true, 'headed Chromium must remain alive after the creation response can be sent')
    assert.equal(page.isClosed(), false)
  } finally {
    if (session) await closeHcmInspection(session.id)
    await new Promise((resolve) => server.close(resolve))
  }
})

test('inspection session expires at its configured lifetime and logs the cleanup reason', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<form method="post" action="/auth"><input type="password"></form>')
    } else response.writeHead(200).end('')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const lifecycle = []
  let session
  try {
    session = await startHcmInspection({
      status: 'Active', auth_method: 'manual', base_url: 'http://browser-test.fixture',
      login_url: 'http://browser-test.fixture/login', approved_navigation_origins: [], approved_resource_origins: [],
    }, {
      headless: true, sessionTtlMs: 60,
      dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
      testTargetIp: '127.0.0.1', testTargetPort: server.address().port,
      onLifecycle: (event) => lifecycle.push(event),
    })
    assert.equal(session.expiresInMs, 60)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(getHcmInspectionState(session.id), null)
    for (let attempt = 0; attempt < 500 && !lifecycle.some((event) => event.event === 'cleanup_complete'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(lifecycle.some((event) => event.event === 'cleanup_complete' && event.reason === 'expired' && event.state === 'EXPIRED'), JSON.stringify(lifecycle.map(({ event, reason, state }) => ({ event, reason, state }))))
  } finally {
    if (session) await closeHcmInspection(session.id)
    await new Promise((resolve) => server.close(resolve))
  }
})

test('unexpected browser process exit cleans up a live inspection session', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<form method="post" action="/auth"><input type="password"></form>')
    } else response.writeHead(200).end('')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const lifecycle = []
  let session
  let browser
  try {
    session = await startHcmInspection({
      status: 'Active', auth_method: 'manual', base_url: 'http://browser-test.fixture',
      login_url: 'http://browser-test.fixture/login', approved_navigation_origins: [], approved_resource_origins: [],
    }, {
      headless: true,
      dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
      testTargetIp: '127.0.0.1', testTargetPort: server.address().port,
      onBrowserReady: (value) => { browser = value },
      onLifecycle: (event) => lifecycle.push(event),
    })
    assert.equal(getHcmInspectionState(session.id).state, 'WAITING_FOR_MANUAL_LOGIN')
    await browser.close()
    for (let attempt = 0; attempt < 20 && getHcmInspectionState(session.id); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(getHcmInspectionState(session.id), null)
    assert.ok(lifecycle.some((event) => event.event === 'browser_disconnected'))
    assert.ok(lifecycle.some((event) => event.event === 'cleanup_complete' && event.reason === 'browser_failure' && event.state === 'FAILED'))
  } finally {
    if (session) await closeHcmInspection(session.id)
    await new Promise((resolve) => server.close(resolve))
  }
})
