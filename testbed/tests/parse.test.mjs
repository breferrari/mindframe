import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { parseDebug } from '../lib/debug.mjs'
import { parseStream } from '../lib/stream.mjs'
import { FIXTURES } from './_helpers.mjs'

const stream = readFileSync(path.join(FIXTURES, 'stream-2.1.289.jsonl'), 'utf8')
const debug = readFileSync(path.join(FIXTURES, 'debug-2.1.289.log'), 'utf8')

test('stream: session facts come from the first init', () => {
  const { session } = parseStream(stream)
  assert.equal(session.version, '2.1.289')
  assert.equal(session.model, 'claude-test-model')
  assert.deepEqual(session.plugins.map((p) => p.name), ['demo-mod', 'builtin-a'])
  assert.equal(session.unparsed, 1)
})

test('stream: SessionStart before the first prompt goes to the preamble', () => {
  const { session, turns } = parseStream(stream)
  assert.equal(session.preamble.length, 1)
  assert.equal(session.preamble[0].event, 'SessionStart')
  assert.equal(session.preamble[0].output, '## Session context\nmeter: 120 bytes')
  assert.ok(!turns[0].hooks.some((h) => h.event === 'SessionStart'))
})

test('stream: turns split at result, with prompt, answer, hooks and what the user saw', () => {
  const { turns } = parseStream(stream)
  assert.equal(turns.length, 2)
  const [t1, t2] = turns
  assert.equal(t1.prompt, 'Say only: one.')
  assert.equal(t1.answer, 'one.')
  assert.deepEqual(t1.hooks.map((h) => h.event), ['UserPromptSubmit', 'Stop'])
  assert.equal(t1.hooks[1].output, '{"systemMessage":"Checklist: one finding"}')
  assert.equal(t1.result.costUsd, 0.01)
  assert.deepEqual(t1.informational, ['Stop says: Checklist: one finding', 'demo-mod: a line drawn under the answer'], 'a line after the result stays with its turn')
  assert.equal(t2.prompt, 'Edit the note, then say only: two.')
  assert.deepEqual(t2.tools, ['Edit'])
  assert.equal(t2.answer, 'two.')
})

test('stream: a failing hook and a hook that never responded are both kept', () => {
  const { turns } = parseStream(stream)
  const post = turns[1].hooks.find((h) => h.event === 'PostToolUse')
  assert.equal(post.name, 'PostToolUse:Edit')
  assert.equal(post.exitCode, 2)
  assert.equal(post.outcome, 'error')
  const stop = turns[1].hooks.find((h) => h.event === 'Stop')
  assert.equal(stop.status, 'started')
  assert.equal(stop.exitCode, null)
})

test('stream: an empty stream gives no turns and no version', () => {
  const { session, turns } = parseStream('')
  assert.equal(turns.length, 0)
  assert.equal(session.version, null)
})

test('debug: registered plugins, loaded modules with their events, timings', () => {
  const d = parseDebug(debug)
  assert.deepEqual(d.registered.map((r) => r.id), ['demo-mod@inline', 'builtin-a@builtin'])
  assert.deepEqual(d.loaded.map((l) => l.id), ['builtin-a@builtin', 'demo-mod@inline'])
  assert.deepEqual(d.loaded[1].events, ['classic.SessionStart', 'prompt.context', 'classic.Stop', 'turn.complete'])
  const mod = d.settled.filter((s) => s.id === 'demo-mod@inline')
  assert.deepEqual(mod.map((s) => [s.event, s.ms]), [['classic.SessionStart', 1126.3], ['prompt.context', 6.9], ['classic.Stop', 426.8]])
})

test('debug: settings hook lines keep their status word; module problems are caught, other noise is not', () => {
  const d = parseDebug(debug)
  assert.deepEqual(d.hooks.map((h) => [h.event, h.name, h.status]), [['SessionStart', 'SessionStart:startup', 'success'], ['Stop', 'Stop', 'success']])
  assert.equal(d.moduleProblems.length, 1)
  assert.equal(d.moduleProblems[0].id, 'demo-mod@inline')
})
