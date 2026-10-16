import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsvText, prepareMockPersistence, validateUpdateBatch } from './timesheetUpdates.mjs'

const current = {
  dates: [{ date: '2026-10-12' }, { date: '2026-10-13' }],
  projects: [{
    project_name: 'cloud spm',
    days: [
      { date: '2026-10-12', hours: 2, hours_status: 'READ' },
      { date: '2026-10-13', hours: 0, hours_status: 'READ' },
    ],
  }],
}

test('normalizes CSV headers and parses required fields', () => {
  const rows = parseCsvText(' User Name , PASSWORD,Date, Project, Log Time, Work Description\nTony,p,2026-10-12, cloud spm ,1.5,Build')
  assert.equal(rows[0]['user name'], 'Tony')
  assert.equal(rows[0]['log time'], '1.5')
  assert.equal(rows[0]['work description'], 'Build')
})

test('rejects malformed or incomplete CSV input', () => {
  assert.throws(() => parseCsvText('user name,password,date\nTony,p,2026-10-12'), /missing required headers/i)
  assert.throws(() => parseCsvText('user name,password,date,project,log time,work description\n"Tony,p,2026-10-12,cloud spm,1,Build'), /unterminated/i)
})

test('matches projects case-insensitively and validates a batch', () => {
  const rows = parseCsvText('user name,password,date,project,log time,work description\nTony,p,2026-10-12,CLOUD SPM,1,Build')
  const validation = validateUpdateBatch(rows, current)
  assert.equal(validation.status, 'READY')
  assert.equal(validation.per_row[0].status, 'READY')
})

test('aggregates same-day additions and rejects the daily limit', () => {
  const rows = parseCsvText('user name,password,date,project,log time,work description\nTony,p,2026-10-12,cloud spm,3,a\nTony,p,2026-10-12,cloud spm,4,b')
  const validation = validateUpdateBatch(rows, current)
  assert.equal(validation.status, 'INVALID')
  assert.equal(validation.per_row[0].status, 'EXCEEDS LIMIT')
})

test('rejects missing projects, dates and unreadable cells', () => {
  const rows = parseCsvText('user name,password,date,project,log time,work description\nTony,p,2026-10-20,missing,1,x')
  const validation = validateUpdateBatch(rows, current)
  assert.equal(validation.status, 'INVALID')
  assert.match(validation.per_row[0].status, /NEEDS DATA|PROJECT MISMATCH/)
})

test('mock persistence verifies updated values without using live Oracle', () => {
  const rows = parseCsvText('user name,password,date,project,log time,work description\nTony,p,2026-10-12,cloud spm,1,Build')
  const validation = validateUpdateBatch(rows, current)
  const persisted = prepareMockPersistence(current, validation)
  assert.equal(persisted.status, 'UPDATED')
  assert.equal(persisted.data.projects[0].days[0].hours, 3)
})
