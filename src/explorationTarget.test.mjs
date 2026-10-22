import test from 'node:test'
import assert from 'node:assert/strict'
import { getRegisteredBaseUrl, MISSING_BASE_URL_MESSAGE } from './explorationTarget.mjs'

test('exploration modal uses the selected registered application Base URL', () => {
  const app = {
    id: 'timesheet-app-id',
    name: 'timesheet',
    base_url: 'https://oracleapex.com/ords/r/drmworkspace/timesheet-application/login',
  }

  assert.equal(
    getRegisteredBaseUrl(app),
    'https://oracleapex.com/ords/r/drmworkspace/timesheet-application/login',
  )
})

test('exploration modal reports no URL for an application without a saved Base URL', () => {
  assert.equal(getRegisteredBaseUrl({ id: 'missing-url', name: 'legacy-app' }), '')
  assert.match(MISSING_BASE_URL_MESSAGE, /no Base URL/)
})
