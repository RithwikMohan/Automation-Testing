import assert from 'node:assert/strict'
import test from 'node:test'
import { getDatabasePool } from './database.mjs'

test('requires DATABASE_URL before creating a pool', () => {
  const previous = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  assert.throws(() => getDatabasePool(), /DATABASE_URL is not configured/)
  if (previous) process.env.DATABASE_URL = previous
})
