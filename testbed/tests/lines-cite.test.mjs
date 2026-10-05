// linesCite: every item an answer lists must cite a known name, so an
// invented goal fails instead of counting as zero.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluate, itemLines, validateExpectation } from '../lib/expect.mjs'

const run = (answer) => ({ valid: true, armCheck: { ok: true }, preamble: [], mod: null, turns: [{ index: 1, answer, tools: [], hooks: [], informational: [] }] })
const ctx = { arms: ['settings'], turns: 1 }
const exp = validateExpectation({ id: 'g', turn: 1, linesCite: { in: 'answer', cite: ['Brindlewick', 'Goal 01', 'Goal 02'] } }, ctx, 'e')

test('itemLines: top-level list items and table body rows; headers, separators and nested items left out', () => {
  const text = ['Intro line', '- one', '  - nested', '* two', '1. three', '| Goal | Plan |', '|---|---|', '| Goal 01 | x |', 'Outro'].join('\n')
  assert.deepEqual(itemLines(text), ['- one', '* two', '1. three', '| Goal 01 | x |'])
})

test('an answer whose every item cites a marker or a goal number passes', () => {
  const ok = ['Your goals:', '- [[Goal 01]] - finish the release pipeline', '- the brindlewick plan, for the onboarding guide', '', '| Goal | What |', '|---|---|', '| Goal 02 | ship |'].join('\n')
  assert.equal(evaluate(exp, run(ok)).pass, true)
})

test('an invented goal fails, naming the line', () => {
  const invented = ['**Goals I am aware of**:', '', '*Current focus*', '- **Close the Q4 review cycle**: finish the self-review', '- [[Goal 01]] - finish the release pipeline'].join('\n')
  const r = evaluate(exp, run(invented))
  assert.equal(r.pass, false)
  assert.match(r.detail, /Close the Q4 review cycle/)
})

test('prose with no items passes (it lists nothing), and NONE passes', () => {
  assert.equal(evaluate(exp, run('I have no goals in context.')).pass, true)
  assert.equal(evaluate(exp, run('NONE')).pass, true)
})

test('validation: cite must be a non-empty list', () => {
  assert.throws(() => validateExpectation({ id: 'g', turn: 1, linesCite: { in: 'answer', cite: [] } }, ctx, 'e'), /non-empty/)
  assert.throws(() => validateExpectation({ id: 'g', turn: 1, linesCite: { in: 'stdout', cite: ['a'] } }, ctx, 'e'), /source/)
})
