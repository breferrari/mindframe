// Every spec in testbed/specs/ loads: its fixtures, files and expectations
// are valid, and every expectation names an arm the scenario runs.
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadSpec } from '../lib/spec.mjs'

const SPECS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'specs')

for (const file of readdirSync(SPECS).filter((f) => f.endsWith('.json'))) {
  test(`spec ${file} loads and every scenario has expectations`, () => {
    const spec = loadSpec(path.join(SPECS, file))
    assert.equal(`${spec.name}.json`, file, 'the file is named after the spec')
    for (const s of spec.scenarios) assert.ok(s.expect.length > 0, `${s.id} expects nothing`)
  })
}

test('the wiki-mind spec covers every extension point on the settings arm and the mod on its own', () => {
  const spec = loadSpec(path.join(SPECS, 'wiki-mind.json'))
  const ids = spec.scenarios.flatMap((s) => s.expect.map((e) => e.id))
  for (const point of ['sections:', 'detectors:', 'signals:', 'validators:', 'mod:']) assert.ok(ids.some((id) => id.startsWith(point)), point)
})
