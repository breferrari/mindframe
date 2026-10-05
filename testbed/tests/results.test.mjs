import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkArm } from '../lib/results.mjs'

const session = (plugins, version = '2.1.289') => ({ version, plugins })
const debug = (ids) => ({ loaded: ids.map((id) => ({ id })) })
const MOD = { name: 'demo-mod', source: 'demo-mod@inline' }

test('mod arm: valid only when init lists the mod and the debug log loaded it', () => {
  assert.equal(checkArm({ arm: 'mod', modName: 'demo-mod', session: session([MOD]), debug: debug(['demo-mod@inline']) }).ok, true)
  assert.equal(checkArm({ arm: 'mod', modName: 'demo-mod', session: session([]), debug: debug(['demo-mod@inline']) }).ok, false)
  assert.equal(checkArm({ arm: 'mod', modName: 'demo-mod', session: session([MOD]), debug: debug([]) }).ok, false)
  assert.equal(checkArm({ arm: 'mod', modName: 'demo-mod', session: session([]), debug: debug([]) }).ok, false)
})

test('settings arm: invalid when the mod shows up in either place', () => {
  assert.equal(checkArm({ arm: 'settings', modName: 'demo-mod', session: session([]), debug: debug([]) }).ok, true)
  assert.equal(checkArm({ arm: 'settings', modName: 'demo-mod', session: session([MOD]), debug: debug([]) }).ok, false)
  assert.equal(checkArm({ arm: 'settings', modName: 'demo-mod', session: session([]), debug: debug(['demo-mod@skills-dir']) }).ok, false)
})

test('another module with a similar name is not the mod', () => {
  const other = { name: 'demo-mod-extra' }
  assert.equal(checkArm({ arm: 'mod', modName: 'demo-mod', session: session([other]), debug: debug(['demo-mod-extra@inline']) }).ok, false)
})

test('no init in the stream means no evidence, so the run is invalid on either arm', () => {
  for (const arm of ['settings', 'mod']) {
    const r = checkArm({ arm, modName: 'demo-mod', session: session([], null), debug: debug([]) })
    assert.equal(r.ok, false)
    assert.match(r.reason, /no init/)
  }
})
