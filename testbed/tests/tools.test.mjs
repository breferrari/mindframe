// Per-scenario tool lists: a scenario can forbid tools outright, so what is
// measured is only what the hooks delivered.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { runSpec } from '../lib/run.mjs'
import { claudeArgs } from '../lib/session.mjs'
import { validateSpec } from '../lib/spec.mjs'
import { FAKE_CLAUDE, makeVault, minimalSpec, tmp } from './_helpers.mjs'

test('disallowedTools becomes --disallowedTools; none means no flag', () => {
  const spec = validateSpec(minimalSpec())
  const base = { arm: 'settings', bed: 'b', mod: spec.mod, debugFile: 'd' }
  assert.ok(!claudeArgs({ ...base, session: spec.session }).includes('--disallowedTools'))
  const args = claudeArgs({ ...base, session: { ...spec.session, disallowedTools: ['Read', 'Grep'] } })
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Read,Grep')
})

test("a scenario's tool lists override the session's for that scenario only", async (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const spec = validateSpec(
    minimalSpec({
      session: { gapMs: 0, settleMs: 0, turnTimeoutMs: 10000, env: { FAKE_CLAUDE: 'echo-disallowed' }, disallowedTools: ['Bash'] },
      scenarios: [
        { id: 'plain', arms: ['settings'], turns: ['x'] },
        { id: 'blind', arms: ['settings'], disallowedTools: ['Read', 'Grep', 'Glob'], turns: ['x'] },
      ],
    }),
  )
  const record = await runSpec({ spec, vault, out, cmd: FAKE_CLAUDE })
  assert.deepEqual(record.runs.map((r) => r.turns[0].answer), ['disallowed: Bash', 'disallowed: Read,Grep,Glob'])
  assert.throws(() => validateSpec(minimalSpec({ scenarios: [{ id: 's', disallowedTools: 'Read', turns: ['x'] }] })), /list of tool names/)
})
