import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_INCLUDE, SpecError, bedPath, validateSpec } from '../lib/spec.mjs'
import { minimalSpec } from './_helpers.mjs'

test('a minimal spec gets defaults: both arms, infrastructure-only include, mod name', () => {
  const s = validateSpec({ ...minimalSpec(), mod: { dir: '.claude/skills/demo-mod' } })
  assert.deepEqual(s.scenarios[0].arms, ['settings', 'mod'])
  assert.deepEqual(s.bed.include, DEFAULT_INCLUDE)
  assert.equal(s.mod.name, 'demo-mod')
  assert.equal(s.session.model, 'opus')
  assert.deepEqual(s.scenarios[0].turns[0], { text: 'Say only: one.', before: [] })
})

test('the default include holds no note folders', () => {
  for (const p of DEFAULT_INCLUDE) assert.ok(p.startsWith('.') || /^[A-Z]+\.md$/.test(p) || p === 'vault-manifest.json', p)
})

test('paths that leave the bed are refused', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/x', 'C:/x', 'C:\\x', 'a\\b', '']) {
    assert.throws(() => bedPath(bad, 'w'), SpecError, bad)
  }
  assert.equal(bedPath('a/./b', 'w'), 'a/b')
})

test('fixtures and actions are checked', () => {
  const withFixture = (f) => validateSpec(minimalSpec({ bed: { fixtures: [f] } }))
  assert.throws(() => withFixture({ path: '../x', content: '' }), /leaves the bed/)
  assert.throws(() => withFixture({ path: 'x', content: 'a', fill: 3 }), /exactly one/)
  assert.throws(() => withFixture({ path: 'x', fill: -1 }), /byte count/)
  const withTurn = (t) => validateSpec(minimalSpec({ scenarios: [{ id: 's', turns: [t] }] }))
  assert.throws(() => withTurn({ text: 'x', before: [{ append: 'n.md', bytes: 0 }] }), /positive bytes/)
  assert.throws(() => withTurn({ text: 'x', before: [{ delete: 'n.md' }] }), /unknown action/)
  assert.throws(() => withTurn({ before: [] }), /needs text/)
})

test('scenarios: ids unique, arms known, the mod arm needs a mod', () => {
  assert.throws(() => validateSpec(minimalSpec({ scenarios: [] })), /non-empty/)
  assert.throws(() => validateSpec(minimalSpec({ scenarios: [{ id: 'a', turns: ['x'] }, { id: 'a', turns: ['y'] }] })), /duplicate/)
  assert.throws(() => validateSpec(minimalSpec({ scenarios: [{ id: 'a', arms: ['cloud'], turns: ['x'] }] })), /unknown arm/)
  assert.throws(() => validateSpec({ ...minimalSpec(), mod: undefined }), /needs spec.mod/)
  const settingsOnly = validateSpec({ ...minimalSpec(), mod: undefined, scenarios: [{ id: 'a', arms: ['settings'], turns: ['x'] }] })
  assert.equal(settingsOnly.mod, null)
})
