// The pieces #11 added: bed.files, bed.manifest, per-scenario env, the
// meter expectation and hook.everyOutput; and the contract spec itself.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildBed } from '../lib/bed.mjs'
import { evaluate, parseMeter, validateExpectation } from '../lib/expect.mjs'
import { runSpec } from '../lib/run.mjs'
import { loadSpec, validateSpec } from '../lib/spec.mjs'
import { FAKE_CLAUDE, makeVault, minimalSpec, tmp, write } from './_helpers.mjs'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const at = (root, rel) => path.join(root, ...rel.split('/'))

test('bed.files: resolved from the spec file, copied into the bed; a missing source is refused', (t) => {
  const dir = tmp(t)
  write(dir, 'fixtures/ext.mjs', 'export default { id: "x" }\n')
  const spec = validateSpec(minimalSpec({ bed: { files: [{ from: '../fixtures/ext.mjs', path: '.claude/extensions/x/index.mjs' }] } }), path.join(dir, 'specs'))
  const bed = path.join(tmp(t), 'bed')
  buildBed({ vault: makeVault(t), bed, spec })
  assert.equal(readFileSync(at(bed, '.claude/extensions/x/index.mjs'), 'utf8'), 'export default { id: "x" }\n')
  assert.throws(() => validateSpec(minimalSpec({ bed: { files: [{ from: 'nope.mjs', path: 'x.mjs' }] } }), dir), /does not exist/)
  assert.throws(() => validateSpec(minimalSpec({ bed: { files: [{ from: '../fixtures/ext.mjs', path: '../x.mjs' }] } }), path.join(dir, 'specs')), /leaves the bed/)
  assert.throws(() => validateSpec(minimalSpec({ bed: { files: [{ from: path.join(dir, 'fixtures', 'ext.mjs'), path: 'x.mjs' }] } }), dir), /relative to the spec file/)
})

test('bed.manifest: set replaces keys, extensions append to the vault\'s own', (t) => {
  const vault = makeVault(t)
  const bed = path.join(tmp(t), 'bed')
  const own = { id: 'own', module: 'own.mjs', events: ['stop'] }
  write(vault, 'vault-manifest.json', JSON.stringify({ template: 'demo', budget: 1, extensions: [own] }))
  const added = { id: 'added', module: 'added.mjs', events: ['session-start'] }
  const spec = validateSpec(minimalSpec({ bed: { manifest: { set: { budget: 2 }, extensions: [added] } } }))
  buildBed({ vault, bed, spec })
  const m = JSON.parse(readFileSync(at(bed, 'vault-manifest.json'), 'utf8'))
  assert.deepEqual(m, { template: 'demo', budget: 2, extensions: [own, added] })
})

test('bed.manifest: refused when it would replace extensions, or is malformed', () => {
  const v = (manifest) => validateSpec(minimalSpec({ bed: { manifest } }))
  assert.throws(() => v({ set: { extensions: [] } }), /may not replace extensions/)
  assert.throws(() => v({ extensions: [{ module: 'x' }] }), /needs an id/)
  assert.throws(() => v({ remove: ['x'] }), /unknown key/)
  assert.throws(() => v([]), /must be an object/)
})

test('a scenario env overrides the session env for that scenario only', async (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const spec = validateSpec(
    minimalSpec({
      session: { gapMs: 0, settleMs: 0, turnTimeoutMs: 10000, env: { FAKE_CLAUDE: 'echo-file=a.txt' } },
      bed: { fixtures: [{ path: 'a.txt', content: 'from session env' }, { path: 'b.txt', content: 'from scenario env' }] },
      scenarios: [
        { id: 'plain', arms: ['settings'], turns: ['x'] },
        { id: 'override', arms: ['settings'], env: { FAKE_CLAUDE: 'echo-file=b.txt' }, turns: ['x'] },
      ],
    }),
  )
  const record = await runSpec({ spec, vault, out, cmd: FAKE_CLAUDE })
  assert.deepEqual(record.runs.map((r) => r.turns[0].answer), ['from session env', 'from scenario env'])
  assert.throws(() => validateSpec(minimalSpec({ scenarios: [{ id: 's', env: { N: 1 }, turns: ['x'] }] })), /must be a string/)
})

test('parseMeter reads sizes, budget, clamp, collapses and truncation', () => {
  assert.deepEqual(parseMeter('_context injected: 2.9kB / 4.0kB budget — collapsed: MF budget unset, MF budget 930_'), { bytes: 2900, budget: 4000, configured: null, collapsed: ['MF budget unset', 'MF budget 930'], degraded: [], truncated: false, other: [] })
  assert.deepEqual(parseMeter('_context injected: 0.1kB / 4.0kB budget_'), { bytes: 100, budget: 4000, configured: null, collapsed: [], degraded: [], truncated: false, other: [] })
  assert.equal(parseMeter('_context injected: 2.5kB_').budget, null)
  assert.equal(parseMeter('_context injected: 9.1kB / 9.1kB budget (12.0kB configured, held under the hook output cap)_').configured, 12000)
  assert.equal(parseMeter('_context injected: 9.9kB / 9.1kB budget — truncated to fit the hook output cap_').truncated, true)
  assert.equal(parseMeter('## Session Context'), null)
})

// A session-start output shaped like the real one.
const sections = (meter, bodies) => ['## Session Context', '## Core', bodies.core ?? 'CORE-BODY', '## A', bodies.a ?? 'A-BODY', '## B', bodies.b ?? 'B-POINTER', meter].join('\n')
const meterRun = (text) => ({ valid: true, armCheck: { ok: true }, preamble: [{ event: 'SessionStart', name: 'SessionStart', status: 'responded', exitCode: 0, output: text }], turns: [], mod: null })
const meterExp = (extra = {}) =>
  validateExpectation(
    { id: 'm', turn: 'preamble', meter: { in: 'hook:SessionStart', maxBytes: 4000, collapsed: ['B'], sections: [{ name: 'Core', body: 'CORE-BODY' }, { name: 'A', body: 'A-BODY' }, { name: 'B', body: 'B-BODY' }], ...extra } },
    { arms: ['settings'], turns: 1 },
    'e',
  )
const M = (line, bodies = {}) => evaluate(meterExp(), meterRun(sections(line, bodies)))

test('meter: passes when the numbers fit and the collapses are true', () => {
  const r = M('_context injected: 0.1kB / 4.0kB budget — collapsed: B_')
  assert.equal(r.pass, true, r.detail)
})

test('meter: each false claim fails', () => {
  const fail = (line, bodies, re) => {
    const r = M(line, bodies)
    assert.equal(r.pass, false, line)
    assert.match(r.detail, re)
  }
  fail('_context injected: 4.1kB / 4.0kB budget — collapsed: B_', {}, /over its 4000-byte budget/)
  fail('_context injected: 0.9kB / 4.0kB budget — collapsed: B_', {}, /only \d+ arrived/)
  fail('_context injected: 0.1kB / 4.0kB budget_', {}, /meter collapsed \[\], expected \[B\]/)
  fail('_context injected: 0.1kB / 4.0kB budget — collapsed: A, B_', {}, /collapsed \[A, B\]/)
  fail('_context injected: 0.1kB / 4.0kB budget — collapsed: B_', { b: 'B-BODY' }, /names B as collapsed, but its body arrived/)
  fail('_context injected: 0.1kB / 4.0kB budget — collapsed: B_', { a: 'gone' }, /A is missing, and the meter doesn't name it/)
  fail('_context injected: 0.1kB / 4.0kB budget — collapsed: B — truncated to fit the hook output cap_', {}, /truncated/)
  fail('_context injected: 0.1kB_', {}, /no budget/)
  fail('the end', {}, /not a meter/)
})

test('meter: maxBytes holds both the reported size and the bytes that arrived', () => {
  const big = sections('_context injected: 0.1kB / 9.0kB budget — collapsed: B_', { core: 'CORE-BODY' + 'x'.repeat(5000) })
  const r = evaluate(meterExp(), meterRun(big))
  assert.equal(r.pass, false)
  assert.match(r.detail, /bytes delivered > 4000/)
  const reported = evaluate(meterExp({ maxBytes: 50 }), meterRun(sections('_context injected: 0.1kB / 4.0kB budget — collapsed: B_', {})))
  assert.equal(reported.pass, false)
  assert.match(reported.detail, /meter reports 100 bytes > 50/)
})

test('hook.everyOutput: every run must match; output needs only one', () => {
  const run = {
    valid: true,
    armCheck: { ok: true },
    preamble: [],
    mod: null,
    turns: [1, 2].map((i) => ({ index: i, answer: '', tools: [], informational: [], hooks: [{ event: 'Stop', name: 'Stop', status: 'responded', exitCode: 0, output: i === 2 ? 'MF-LEAK' : '{}' }] })),
  }
  const ev = (hook) => evaluate(validateExpectation({ id: 'h', turn: 'all', hook }, { arms: ['settings'], turns: 2 }, 'e'), run)
  assert.equal(ev({ event: 'Stop', output: { not: 'MF-' } }).pass, true, 'one clean output is enough for output')
  const every = ev({ event: 'Stop', everyOutput: { not: 'MF-' } })
  assert.equal(every.pass, false)
  assert.match(every.detail, /MF-LEAK/)
})

test('the contract spec loads, every fixture exists, and every extension is declared once', () => {
  const spec = loadSpec(path.join(REPO, 'testbed', 'specs', 'contract.json'))
  const declared = spec.bed.manifest.extensions.map((d) => d.id)
  assert.equal(new Set(declared).size, declared.length)
  for (const f of spec.bed.files) {
    const id = f.path.split('/')[2]
    assert.ok(declared.includes(id), `${id} is copied but not declared`)
  }
  for (const d of spec.bed.manifest.extensions) assert.ok(spec.bed.files.some((f) => f.path === d.module), `${d.id} is declared but not copied`)
})

test('the fixture extensions load and have the shape the spec relies on', async () => {
  const dir = path.join(REPO, 'testbed', 'fixtures', 'contract')
  const load = async (name) => (await import(new URL(`file:///${path.join(dir, name).replace(/\\/g, '/')}`).href)).default
  const order = await load('mf-order.mjs')
  assert.deepEqual(order.sections.map((s) => s.id), ['p20', 'unset', 'tie-b', 'tie-a', 'p10'], 'listed out of order on purpose')
  const thrower = await load('mf-thrower.mjs')
  assert.throws(() => thrower.sections[0].render())
  await assert.rejects(thrower.detectors[0].detect())
  assert.equal(typeof thrower.validators[0].validate(), 'string')
  const getter = await load('mf-getter.mjs')
  assert.throws(() => getter.sections)
  const witness = await load('mf-witness.mjs')
  assert.equal(witness.signals[0].match('MF-PING'), true)
  const budget = await load('mf-budget.mjs')
  assert.equal(budget.sections.find((s) => s.id === 'core').pointer, undefined, 'core is load-bearing')
})
