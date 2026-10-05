import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluate, isNone, isSilent, locate, matches, validateExpectation } from '../lib/expect.mjs'
import { validateSpec } from '../lib/spec.mjs'
import { minimalSpec } from './_helpers.mjs'

const hook = (event, output = '', extra = {}) => ({ event, name: event, status: 'responded', exitCode: 0, outcome: 'success', output, ...extra })
const turn = (index, extra = {}) => ({ index, prompt: `p${index}`, answer: '', tools: [], hooks: [], informational: [], ...extra })
const run = (extra = {}) => ({ scenario: 's', arm: 'settings', valid: true, armCheck: { ok: true }, preamble: [], turns: [], mod: null, ...extra })
const ctx = { arms: ['settings', 'mod'], turns: 3 }
const ev = (e, r) => evaluate(validateExpectation(e, ctx, 'e'), r)

test('matchers: string includes, re, equals, none, not, all, any', () => {
  assert.ok(matches('lo w', 'hello world'))
  assert.ok(!matches('LO', 'hello'))
  assert.ok(matches({ re: '^h.*d$' }, 'hello world'))
  assert.ok(matches({ re: 'HELLO', flags: 'i' }, 'hello'))
  assert.ok(matches({ equals: 'x' }, ' x\n'))
  assert.ok(!matches({ equals: 'x' }, 'xy'))
  assert.ok(matches({ not: 'zzz' }, 'hello'))
  assert.ok(matches({ all: ['he', 'wo'] }, 'hello world'))
  assert.ok(!matches({ all: ['he', 'zz'] }, 'hello world'))
  assert.ok(matches({ any: ['zz', 'wo'] }, 'hello world'))
})

test('NONE, however the model dresses it, and nothing else', () => {
  for (const s of ['NONE', 'NONE.', ' none ', '`NONE`', '**NONE**', '"NONE"']) assert.ok(isNone(s), s)
  for (const s of ['NONE of them', 'Wrap-up checklist:', '', 'NO']) assert.ok(!isNone(s), s)
  assert.ok(matches({ none: true }, 'NONE.'))
  assert.ok(matches({ not: { none: true } }, 'Wrap-up checklist:'))
})

test('silent means no content for anyone: empty or {}', () => {
  assert.ok(isSilent(''))
  assert.ok(isSilent(' {}\n'))
  assert.ok(!isSilent('{"systemMessage":"x"}'))
})

test('locate gives a position for includes and re only', () => {
  assert.equal(locate('b', 'abc'), 1)
  assert.equal(locate({ re: 'c' }, 'abc'), 2)
  assert.equal(locate('z', 'abc'), -1)
  assert.throws(() => locate({ none: true }, 'abc'))
})

test('validation: one kind, a real turn, arms within the scenario, sound matchers', () => {
  assert.throws(() => validateExpectation({ id: 'x', turn: 1 }, ctx, 'e'), /exactly one/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 1, answer: 'a', shown: 'b' }, ctx, 'e'), /exactly one/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 4, answer: 'a' }, ctx, 'e'), /turn must be/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 0, answer: 'a' }, ctx, 'e'), /turn must be/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 1, answer: 'a', arms: ['cloud'] }, ctx, 'e'), /not one of/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 1, answer: { re: '(' } }, ctx, 'e'), /re:/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 1, answer: { includes: 'a', re: 'b' } }, ctx, 'e'), /exactly one of includes/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 1, order: { in: 'answer', items: ['a', { none: true }] } }, ctx, 'e'), /use includes or re/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 1, order: { in: 'stdout', items: ['a', 'b'] } }, ctx, 'e'), /source/)
  assert.throws(() => validateExpectation({ id: 'x', modEvent: { event: 'turn.complete' } }, ctx, 'e'), /mod arm only/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 'any', judge: { question: 'q', rubric: 'r' } }, ctx, 'e'), /numbered turn/)
  assert.throws(() => validateExpectation({ id: 'x', turn: 1, hook: { event: 'Stop', ran: false, silent: true } }, ctx, 'e'), /no other checks/)
  assert.equal(validateExpectation({ id: 'x', turn: 1, answer: 'a' }, ctx, 'e').kind, 'answer')
})

test('validation runs inside the spec: duplicate ids and bad expectations are SpecErrors', () => {
  const spec = (expect) => validateSpec(minimalSpec({ scenarios: [{ id: 's', turns: ['a', 'b'], expect }] }))
  assert.throws(() => spec([{ id: 'x', turn: 1, answer: 'a' }, { id: 'x', turn: 2, answer: 'b' }]), /duplicate id/)
  assert.throws(() => spec([{ id: 'x', turn: 3, answer: 'a' }]), /turn must be 1..2/)
  assert.equal(spec([{ id: 'x', turn: 1, answer: 'a' }]).scenarios[0].expect[0].arms.length, 2)
})

test('hook: ran, exit, silent, output, name, and ran: false', () => {
  const r = run({
    preamble: [hook('SessionStart', 'ctx', { name: 'SessionStart:startup' })],
    turns: [turn(1, { hooks: [hook('Stop', '{"systemMessage":"Wrap-up"}')] }), turn(2, { hooks: [hook('Stop', '{}')] })],
  })
  assert.equal(ev({ id: 'a', turn: 1, hook: { event: 'Stop', output: 'Wrap-up' } }, r).pass, true)
  assert.equal(ev({ id: 'a', turn: 2, hook: { event: 'Stop', output: 'Wrap-up' } }, r).pass, false)
  assert.equal(ev({ id: 'a', turn: 2, hook: { event: 'Stop', silent: true } }, r).pass, true)
  assert.equal(ev({ id: 'a', turn: 1, hook: { event: 'Stop', silent: true } }, r).pass, false)
  assert.equal(ev({ id: 'a', turn: 1, hook: { event: 'Stop', silent: false } }, r).pass, true)
  assert.equal(ev({ id: 'a', turn: 'any', hook: { event: 'Stop', silent: true } }, r).pass, false, 'any + silent needs every run silent')
  assert.equal(ev({ id: 'a', turn: 'preamble', hook: { event: 'SessionStart', name: 'startup' } }, r).pass, true)
  assert.equal(ev({ id: 'a', turn: 'preamble', hook: { event: 'SessionStart', name: 'compact' } }, r).pass, false)
  assert.equal(ev({ id: 'a', turn: 1, hook: { event: 'PreCompact' } }, r).pass, false)
  assert.equal(ev({ id: 'a', turn: 1, hook: { event: 'PreCompact', ran: false } }, r).pass, true)
  assert.equal(ev({ id: 'a', turn: 1, hook: { event: 'Stop', ran: false } }, r).pass, false)
})

test('hook: a failed or unanswered hook fails the expectation, unless that exit is expected', () => {
  const r = run({
    turns: [
      turn(1, { hooks: [hook('PostToolUse', 'boom', { exitCode: 2, outcome: 'error' })] }),
      turn(2, { hooks: [hook('Stop', '', { status: 'started', exitCode: null })] }),
    ],
  })
  const failed = ev({ id: 'a', turn: 1, hook: { event: 'PostToolUse' } }, r)
  assert.equal(failed.pass, false)
  assert.match(failed.detail, /exit 2/)
  assert.equal(ev({ id: 'a', turn: 1, hook: { event: 'PostToolUse', exit: 2 } }, r).pass, true)
  const hung = ev({ id: 'a', turn: 2, hook: { event: 'Stop' } }, r)
  assert.equal(hung.pass, false)
  assert.match(hung.detail, /no response/)
})

test('answer, shown and tools read one turn; a missing turn fails', () => {
  const r = run({ turns: [turn(1, { answer: 'NONE', informational: ['Stop says: Wrap-up'], tools: ['Edit', 'Read'] })] })
  assert.equal(ev({ id: 'a', turn: 1, answer: { none: true } }, r).pass, true)
  assert.equal(ev({ id: 'a', turn: 1, answer: { not: { none: true } } }, r).pass, false)
  assert.equal(ev({ id: 'a', turn: 1, shown: 'Wrap-up' }, r).pass, true)
  assert.equal(ev({ id: 'a', turn: 1, tools: { includes: ['Edit'] } }, r).pass, true)
  assert.equal(ev({ id: 'a', turn: 1, tools: { includes: ['Write'] } }, r).pass, false)
  assert.equal(ev({ id: 'a', turn: 1, tools: { max: 1 } }, r).pass, false)
  const gone = ev({ id: 'a', turn: 2, answer: 'x' }, r)
  assert.equal(gone.pass, false)
  assert.match(gone.detail, /not in the run/)
})

test('order: presence is checked before position', () => {
  const r = run({ turns: [turn(1, { hooks: [hook('SessionStart', '## A\n## B\n## C')] })] })
  assert.equal(ev({ id: 'o', turn: 1, order: { in: 'hook:SessionStart', items: ['## A', '## B', '## C'] } }, r).pass, true)
  assert.equal(ev({ id: 'o', turn: 1, order: { in: 'hook:SessionStart', items: ['## B', '## A'] } }, r).pass, false)
  const missing = ev({ id: 'o', turn: 1, order: { in: 'hook:SessionStart', items: ['## Z', '## A'] } }, r)
  assert.equal(missing.pass, false, 'a missing first item (-1) must not pass as "before"')
  assert.match(missing.detail, /missing/)
})

test('budget: bytes counted exactly, last line, survivors and dropped sections', () => {
  const text = 'x'.repeat(95) + '\nmeter' // 101 bytes
  const r = run({ turns: [turn(1, { hooks: [hook('SessionStart', text)] })] })
  const b = (v) => ev({ id: 'b', turn: 1, budget: { in: 'hook:SessionStart', ...v } }, r)
  assert.equal(b({ maxBytes: 101 }).pass, true)
  assert.equal(b({ maxBytes: 100 }).pass, false, 'one byte over the cap fails')
  assert.equal(b({ lastLine: 'meter' }).pass, true)
  assert.equal(b({ lastLine: 'xxx' }).pass, false)
  assert.equal(b({ present: ['meter'], absent: ['low priority'] }).pass, true)
  assert.equal(b({ absent: ['meter'] }).pass, false)
  const empty = run({ turns: [turn(1)] })
  assert.equal(ev({ id: 'b', turn: 1, budget: { in: 'hook:SessionStart', maxBytes: 10 } }, empty).pass, false, 'nothing delivered is not within budget')
})

test('isolates: hook succeeded, names the failed extension, kept the others', () => {
  const good = run({ turns: [turn(1, { hooks: [hook('SessionStart', '## A\nextension thrower failed: boom\n## C')] })] })
  const iso = (r, present = ['## A', '## C']) => ev({ id: 'i', turn: 1, isolates: { event: 'SessionStart', extension: 'thrower', present } }, r)
  assert.equal(iso(good).pass, true)
  assert.equal(iso(good, ['## B']).pass, false)
  const silent = run({ turns: [turn(1, { hooks: [hook('SessionStart', '## A\n## C')] })] })
  assert.equal(iso(silent).pass, false, 'a skipped extension must be reported')
  const crashed = run({ turns: [turn(1, { hooks: [hook('SessionStart', 'thrower', { exitCode: 1 })] })] })
  assert.equal(iso(crashed).pass, false, 'the hook itself must succeed')
})

test('modEvent: settled count and slowest time; invalid runs fail everything', () => {
  const r = run({ arm: 'mod', mod: { timings: [{ event: 'classic.Stop', ms: 400 }, { event: 'classic.Stop', ms: 900 }] } })
  const m = (v) => evaluate(validateExpectation({ id: 'm', arms: ['mod'], modEvent: v }, ctx, 'e'), r)
  assert.equal(m({ event: 'classic.Stop', min: 2 }).pass, true)
  assert.equal(m({ event: 'classic.Stop', min: 3 }).pass, false)
  assert.equal(m({ event: 'classic.Stop', maxMs: 800 }).pass, false)
  assert.equal(m({ event: 'prompt.context' }).pass, false)
  const bad = run({ valid: false, armCheck: { ok: false, reason: 'the mod demo did not load' }, turns: [turn(1, { answer: 'x' })] })
  const res = ev({ id: 'a', turn: 1, answer: 'x' }, bad)
  assert.equal(res.pass, false)
  assert.match(res.detail, /run invalid/)
})

test("'any' passes when one turn passes", () => {
  const r = run({ turns: [turn(1, { informational: [] }), turn(2, { informational: ['mod: line'] })] })
  assert.equal(ev({ id: 'a', turn: 'any', shown: 'mod: line' }, r).pass, true)
  assert.equal(ev({ id: 'a', turn: 1, shown: 'mod: line' }, r).pass, false)
})
