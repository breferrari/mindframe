// A /compact turn as 2.1.289 streams it, and re-grading stored runs.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { reparse } from '../lib/reparse.mjs'
import { buildRun } from '../lib/results.mjs'
import { parseStream, preCompactHooks } from '../lib/stream.mjs'
import { FIXTURES, tmp } from './_helpers.mjs'

const stream = readFileSync(path.join(FIXTURES, 'stream-compact-2.1.289.jsonl'), 'utf8')

test('/compact is its own turn: its SessionStart and PreCompact land there, not on the turn before', () => {
  const { session, turns } = parseStream(stream)
  assert.equal(turns.length, 3)
  assert.deepEqual(session.preamble.map((h) => h.name), ['SessionStart:startup'])
  assert.deepEqual(turns[0].hooks.map((h) => h.name), ['UserPromptSubmit', 'Stop'])
  assert.deepEqual(turns[0].informational, ['demo-mod: a line under the answer'], 'a line after the result still stays with its turn')
  assert.deepEqual(turns[1].hooks.map((h) => h.name), ['SessionStart:compact', 'PreCompact'])
  assert.equal(turns[1].hooks[0].output, '## Session Context\npointer')
  assert.equal(turns[1].hooks[1].exitCode, 0)
  assert.match(turns[1].prompt, /^<local-command-stdout>Compacted/)
  assert.deepEqual(turns[2].hooks.map((h) => h.name), ['UserPromptSubmit', 'Stop'])
  assert.equal(turns[2].answer, 'pointer')
})

test('PreCompact from the command output: brackets inside the command, failures, several hooks', () => {
  const ok = preCompactHooks('<local-command-stdout>Compacted PreCompact [x "$( [ -f a ] && b )"] completed successfully</local-command-stdout>')
  assert.equal(ok.length, 1)
  assert.equal(ok[0].outcome, 'success')
  const two = preCompactHooks('<local-command-stdout>Compacted PreCompact [a [b]] completed successfully, PreCompact [c] failed with exit 2</local-command-stdout>')
  assert.deepEqual(two.map((h) => [h.exitCode, h.outcome]), [[0, 'success'], [1, 'error']])
  assert.match(two[1].stderr, /failed with exit 2/)
  assert.deepEqual(preCompactHooks('<local-command-stdout>Compacted</local-command-stdout>'), [])
})

test('a session records its cost: the last running total any result reported', () => {
  const run = buildRun({ scenario: 's', arm: 'settings', modName: null, streamText: stream, debugText: '', exitCode: 0, feed: [] })
  assert.equal(run.costUsd, 0.22)
  const none = buildRun({ scenario: 's', arm: 'settings', modName: null, streamText: '', debugText: '', exitCode: 0, feed: [] })
  assert.equal(none.costUsd, null)
})

test('reparse rebuilds runs from their logs, keeps what only the run knew, and keeps the old results', (t) => {
  const out = tmp(t)
  mkdirSync(path.join(out, 'logs'))
  writeFileSync(path.join(out, 'logs', 's-settings.jsonl'), stream)
  const residue = { leaks: [], touched: [{ kind: 'cache', file: 'x' }] }
  // A results.json from an older parser: the compact hooks on turn 1.
  const stale = { spec: 'demo', specDoc: { mod: null }, runs: [{ scenario: 's', arm: 'settings', exitCode: 0, feed: [{ turn: 0 }], residue, turns: [{ index: 1, hooks: [{ name: 'SessionStart:compact' }] }] }] }
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(stale))
  const { record, kept } = reparse(out, new Date('2026-01-01T00:00:00Z'))
  assert.deepEqual(record.runs[0].turns[1].hooks.map((h) => h.name), ['SessionStart:compact', 'PreCompact'])
  assert.deepEqual(record.runs[0].residue, residue, 'the residue snapshot is kept as recorded')
  assert.deepEqual(record.runs[0].feed, [{ turn: 0 }])
  assert.equal(record.reparsed, '2026-01-01T00:00:00.000Z')
  assert.ok(existsSync(kept))
  assert.deepEqual(JSON.parse(readFileSync(kept, 'utf8')), stale, 'the previous results are kept byte for byte in meaning')
  assert.equal(readdirSync(out).filter((f) => f.startsWith('results')).length, 2)
})

test('reparse refuses a dry run, and a run whose log is missing', (t) => {
  const out = tmp(t)
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ dry: true, runs: [] }))
  assert.throws(() => reparse(out), /dry run/)
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ specDoc: {}, runs: [{ scenario: 's', arm: 'mod' }] }))
  assert.throws(() => reparse(out), /no stream log for s\/mod/)
})
