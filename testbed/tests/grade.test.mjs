import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { EXIT, grade, hookTable, renderMarkdown } from '../lib/grade.mjs'
import * as judge from '../lib/judge.mjs'
import { validateSpec } from '../lib/spec.mjs'
import { FAKE_CLAUDE, makeVault, minimalSpec, tmp } from './_helpers.mjs'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bed.mjs')

const hook = (event, output = '', extra = {}) => ({ event, name: event, status: 'responded', exitCode: 0, outcome: 'success', output, ...extra })
const spec = validateSpec(
  minimalSpec({
    scenarios: [
      {
        id: 's',
        turns: ['a', 'b'],
        expect: [
          { id: 'answers a', turn: 1, answer: 'A' },
          { id: 'stop silent', arms: ['mod'], turn: 2, hook: { event: 'Stop', silent: true } },
          { id: 'applies the rule', turn: 2, judge: { question: 'Deploy now?', rubric: 'pass if it mentions the freeze' } },
        ],
      },
    ],
  }),
)
const record = {
  spec: 'demo',
  vault: { commit: { head: 'a'.repeat(40), dirty: false } },
  runs: [
    { scenario: 's', arm: 'settings', valid: true, armCheck: { ok: true }, claudeVersion: '2.1.289', preamble: [hook('SessionStart', 'ctx')], turns: [{ index: 1, answer: 'A', tools: [], hooks: [hook('Stop', '{}')], informational: [] }, { index: 2, answer: 'freeze applies', tools: [], hooks: [hook('Stop', 'x', { exitCode: 1, outcome: 'error' })], informational: [] }], mod: null },
    { scenario: 's', arm: 'mod', valid: true, armCheck: { ok: true }, claudeVersion: '2.1.289', preamble: [hook('SessionStart', '')], turns: [{ index: 1, answer: 'B', tools: [], hooks: [hook('Stop', '{}')], informational: [] }, { index: 2, answer: 'ship it', tools: [], hooks: [hook('Stop', '{}')], informational: [] }], mod: { timings: [{ event: 'classic.Stop', ms: 5 }] } },
  ],
}

test('grade: one row per expectation per arm; judged rows wait for verdicts', () => {
  const g = grade(record, spec)
  assert.deepEqual(g.rows.map((r) => [r.id, r.arm, r.pass]), [
    ['answers a', 'settings', true],
    ['answers a', 'mod', false],
    ['stop silent', 'mod', true],
    ['applies the rule', 'settings', null],
    ['applies the rule', 'mod', null],
  ])
  assert.equal(g.failed, 1)
  assert.equal(g.pending, 2)
  assert.equal(g.outcome, 'fail')
  const withVerdicts = grade(record, spec, { 's/settings/applies the rule': true, 's/mod/applies the rule': false })
  assert.equal(withVerdicts.pending, 0)
  assert.equal(withVerdicts.failed, 2)
})

test('grade: an invalid run fails the grade even with no expectations on it', () => {
  const bare = validateSpec(minimalSpec())
  const r = { ...record, runs: [{ ...record.runs[0], scenario: 'basic', valid: false, armCheck: { ok: false, reason: 'x' } }] }
  const g = grade(r, bare)
  assert.equal(g.rows.length, 0)
  assert.equal(g.outcome, 'fail')
  assert.deepEqual(g.invalid, ['basic/settings'])
})

test('grade: judged rows still pending make it incomplete, never a pass', () => {
  const passing = validateSpec(
    minimalSpec({
      scenarios: [{ id: 's', turns: ['a', 'b'], expect: [{ id: 'answers', arms: ['settings'], turn: 1, answer: 'A' }, { id: 'rule', arms: ['settings'], turn: 2, judge: { question: 'q', rubric: 'r' } }] }],
    }),
  )
  const g = grade(record, passing)
  assert.equal(g.failed, 0)
  assert.equal(g.pending, 1)
  assert.equal(g.outcome, 'incomplete')
  assert.equal(EXIT.incomplete, 3)
  assert.notEqual(EXIT.incomplete, EXIT.fail)
  assert.notEqual(EXIT.incomplete, EXIT.pass)
  const md = renderMarkdown(record, g)
  assert.match(md.split('\n').slice(0, 6).join('\n'), /\*\*INCOMPLETE\*\*/)
  assert.match(md, /Not a pass/)
  assert.equal(grade(record, passing, { 's/settings/rule': true }).outcome, 'pass')
  assert.equal(grade(record, passing, { 's/settings/rule': false }).outcome, 'fail')
})

test('hook table: runs, failures and silent runs per event and arm', () => {
  const t = hookTable(record)
  assert.deepEqual(t.arms, ['settings', 'mod'])
  assert.deepEqual(t.cells.Stop.settings, { ran: 2, failed: 1, silent: 1 })
  assert.deepEqual(t.cells.Stop.mod, { ran: 2, failed: 0, silent: 2 })
  assert.deepEqual(t.cells.SessionStart.mod, { ran: 1, failed: 0, silent: 1 })
  assert.deepEqual(t.mod['classic.Stop'], { n: 1, maxMs: 5 })
})

test('markdown: verdict, expectations by arm, hooks by arm', () => {
  const md = renderMarkdown(record, grade(record, spec))
  assert.match(md, /\*\*FAIL\*\*: 2 passed, 1 failed, 2 awaiting/)
  assert.match(md, /\| s \| answers a \| 1 \| ✅ \| ❌ answer: "B" \|/)
  assert.match(md, /\| Stop \| 2 ran, \*\*1 failed\*\*, 1 silent \| 2 ran, 2 silent \|/)
  assert.match(md, /Claude Code 2\.1\.289/)
})

test('judge: blind items carry no scenario or arm, and verdicts map back', () => {
  const { blind, key, prompt } = judge.prepare(record, spec, () => 0)
  assert.equal(blind.length, 2)
  for (const b of blind) assert.deepEqual(Object.keys(b).sort(), ['answer', 'key', 'question', 'rubric'])
  assert.ok(!prompt.includes('settings') && !prompt.includes('"mod"'))
  const verdicts = judge.apply(key, blind.map((b) => ({ key: b.key, pass: b.answer.includes('freeze') })))
  assert.deepEqual(verdicts, { 's/settings/applies the rule': true, 's/mod/applies the rule': false })
})

test('judge: a missing, duplicate or unknown verdict refuses the whole set', () => {
  const { key } = judge.prepare(record, spec, () => 0)
  assert.throws(() => judge.apply(key, [{ key: 0, pass: true }]), /no verdict/)
  assert.throws(() => judge.apply(key, [{ key: 0, pass: true }, { key: 0, pass: false }]), /twice/)
  assert.throws(() => judge.apply(key, [{ key: 0, pass: true }, { key: 1, pass: true }, { key: 9, pass: true }]), /unknown key/)
  assert.throws(() => judge.apply(key, [{ key: 0, pass: 'yes' }, { key: 1, pass: true }]), /true or false/)
})

test('cli: run grades at the end and exits 1 on a failed expectation; grade re-grades', async (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const specFile = path.join(tmp(t), 'spec.json')
  writeFileSync(
    specFile,
    JSON.stringify(
      minimalSpec({
        scenarios: [
          {
            id: 'basic',
            turns: ['Say only: one.'],
            expect: [
              { id: 'echoes', turn: 1, answer: 'echo: Say only: one.' },
              { id: 'stop ran', turn: 1, hook: { event: 'Stop', silent: true } },
              { id: 'wrong on purpose', arms: ['mod'], turn: 1, answer: 'nope' },
            ],
          },
        ],
      }),
    ),
  )
  const node = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' }) }
    } catch (e) {
      return { code: e.status, out: e.stdout }
    }
  }
  const r = node(['run', '--vault', vault, '--spec', specFile, '--out', out, '--claude', FAKE_CLAUDE[0], '--claude-arg', FAKE_CLAUDE[1]])
  assert.equal(r.code !== 0, true, r.out)
  assert.match(readFileSync(path.join(out, 'results.md'), 'utf8'), /\| basic \| wrong on purpose \| 1 \| — \| ❌/)
  const g = JSON.parse(readFileSync(path.join(out, 'grades.json'), 'utf8'))
  assert.equal(g.failed, 1)
  assert.equal(node(['grade', path.join(out, 'results.json')]).code, 1)
})

test('cli: a run whose only gap is a pending judge exits 3', (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const specFile = path.join(tmp(t), 'spec.json')
  writeFileSync(
    specFile,
    JSON.stringify(minimalSpec({ scenarios: [{ id: 'basic', arms: ['settings'], turns: ['one'], expect: [{ id: 'echoes', turn: 1, answer: 'echo: one' }, { id: 'judged', turn: 1, judge: { question: 'q', rubric: 'r' } }] }] })),
  )
  let code = 0
  try {
    execFileSync(process.execPath, [BIN, 'run', '--vault', vault, '--spec', specFile, '--out', out, '--claude', FAKE_CLAUDE[0], '--claude-arg', FAKE_CLAUDE[1]], { encoding: 'utf8' })
  } catch (e) {
    code = e.status
  }
  assert.equal(code, 3)
  assert.match(readFileSync(path.join(out, 'results.md'), 'utf8'), /\*\*INCOMPLETE\*\*/)
})
