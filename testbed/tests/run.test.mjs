// The runner end to end against a stand-in claude (fixtures/fake-claude.mjs).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { defaultOut, runSpec } from '../lib/run.mjs'
import { claudeArgs } from '../lib/session.mjs'
import { validateSpec } from '../lib/spec.mjs'
import { FAKE_CLAUDE, makeVault, minimalSpec, tmp } from './_helpers.mjs'

test('both arms run in their own bed and come back valid, turn by turn', async (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const record = await runSpec({ spec: validateSpec(minimalSpec()), vault, out, cmd: FAKE_CLAUDE })

  assert.deepEqual(record.runs.map((r) => [r.scenario, r.arm, r.valid]), [['basic', 'settings', true], ['basic', 'mod', true]])
  for (const run of record.runs) {
    assert.equal(run.exitCode, 0)
    assert.deepEqual(run.turns.map((x) => x.prompt), ['Say only: one.', 'Say only: two.'])
    assert.deepEqual(run.turns.map((x) => x.answer), ['echo: Say only: one.', 'echo: Say only: two.'])
    assert.deepEqual(run.turns[0].hooks.map((h) => h.event), ['UserPromptSubmit', 'Stop'])
  }
  const [settings, mod] = record.runs
  assert.equal(settings.preamble[0].output, 'session context')
  assert.equal(mod.preamble[0].output, '', 'the mod stood the settings hook down')
  assert.deepEqual(mod.mod.timings.map((x) => x.event), ['classic.SessionStart', 'classic.Stop', 'classic.Stop'])
  assert.equal(settings.mod.timings.length, 0)

  assert.ok(existsSync(path.join(out, 'results.json')))
  assert.ok(existsSync(path.join(out, 'beds', 'basic-mod', '.claude', 'skills', 'demo-mod')))
  assert.ok(existsSync(path.join(out, 'logs', 'basic-mod.debug')))
})

test('a mod that never loads makes the mod-arm run invalid', async (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const spec = validateSpec(minimalSpec({ session: { gapMs: 0, settleMs: 0, turnTimeoutMs: 10000, env: { FAKE_CLAUDE: 'no-mod-load' } } }))
  const record = await runSpec({ spec, vault, out, cmd: FAKE_CLAUDE, arms: ['mod'] })
  assert.equal(record.runs.length, 1)
  assert.equal(record.runs[0].valid, false)
  assert.match(record.runs[0].armCheck.reason, /did not load/)
})

test("a turn's actions run before the turn is sent", async (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const spec = validateSpec(
    minimalSpec({
      session: { gapMs: 0, settleMs: 0, turnTimeoutMs: 10000, env: { FAKE_CLAUDE: 'echo-file=probe.txt' } },
      bed: { fixtures: [{ path: 'probe.txt', content: 'before' }] },
      scenarios: [{ id: 'act', arms: ['settings'], turns: ['first', { text: 'second', before: [{ write: 'probe.txt', content: 'after' }] }] }],
    }),
  )
  const record = await runSpec({ spec, vault, out, cmd: FAKE_CLAUDE })
  assert.deepEqual(record.runs[0].turns.map((x) => x.answer), ['before', 'after'])
})

test('each turn waits for the previous result, so no two prompts fold into one turn', async (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const spec = validateSpec(
    minimalSpec({
      session: { gapMs: 0, settleMs: 0, turnTimeoutMs: 10000, env: { FAKE_CLAUDE: 'slow' } },
      scenarios: [{ id: 'pace', arms: ['settings'], turns: ['one', 'two', 'three'] }],
    }),
  )
  const record = await runSpec({ spec, vault, out, cmd: FAKE_CLAUDE })
  assert.deepEqual(record.runs[0].turns.map((x) => x.answer), ['echo: one', 'echo: two', 'echo: three'])
})

test('a session that exits early stops the feed and keeps what arrived', async (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const spec = validateSpec(minimalSpec({ session: { gapMs: 0, settleMs: 0, turnTimeoutMs: 10000, env: { FAKE_CLAUDE: 'exit-early' } } }))
  const record = await runSpec({ spec, vault, out, cmd: FAKE_CLAUDE, arms: ['settings'] })
  const run = record.runs[0]
  assert.equal(run.turns.length, 1)
  assert.ok(run.feed.some((f) => f.stopped === 'exited'))
})

test('the output folder must be new, and defaults to outside the repo', (t) => {
  const out = tmp(t)
  mkdirSync(path.join(out, 'x'))
  return assert.rejects(runSpec({ spec: validateSpec(minimalSpec()), vault: out, out: path.join(out, 'x'), cmd: FAKE_CLAUDE }), /exists/).then(() => {
    const d = defaultOut('demo', new Date('2026-01-02T03:04:05.678Z'))
    assert.ok(d.startsWith(os.tmpdir()))
    assert.equal(path.basename(d), 'demo-2026-01-02T03-04-05-678Z')
  })
})

test('claude flags: the mod arm adds --plugin-dir to the bed copy, settings never does', () => {
  const spec = validateSpec(minimalSpec({ session: { allowedTools: ['Edit', 'Bash'] } }))
  const base = { bed: path.join('beds', 'b'), mod: spec.mod, session: spec.session, debugFile: 'd.log' }
  const settings = claudeArgs({ ...base, arm: 'settings' })
  const mod = claudeArgs({ ...base, arm: 'mod' })
  assert.ok(!settings.includes('--plugin-dir'))
  assert.equal(mod[mod.indexOf('--plugin-dir') + 1], path.join('beds', 'b', '.claude', 'skills', 'demo-mod'))
  for (const f of ['--include-hook-events', '--replay-user-messages', '--strict-mcp-config', '--verbose']) assert.ok(settings.includes(f), f)
  assert.equal(settings[settings.indexOf('--setting-sources') + 1], 'project,local')
  assert.equal(settings[settings.indexOf('--model') + 1], 'opus')
  assert.equal(settings[settings.indexOf('--allowedTools') + 1], 'Edit,Bash')
})

test('results.json is valid JSON with one record per run', async (t) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  await runSpec({ spec: validateSpec(minimalSpec()), vault, out, cmd: FAKE_CLAUDE, only: ['basic'], arms: ['settings'] })
  const record = JSON.parse(readFileSync(path.join(out, 'results.json'), 'utf8'))
  assert.equal(record.spec, 'demo')
  assert.equal(record.runs.length, 1)
  assert.match(record.vault.commit.head, /^[0-9a-f]{40}$/)
})
