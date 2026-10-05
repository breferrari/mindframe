import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bedEnv, dryRun } from '../lib/dry.mjs'
import { grade, renderMarkdown } from '../lib/grade.mjs'
import { qmdEnv } from '../lib/residue.mjs'
import { validateSpec } from '../lib/spec.mjs'
import { makeVault, minimalSpec, tmp, write } from './_helpers.mjs'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bed.mjs')

// Entry points that report what they were given. stop-checklist writes into
// the user's qmd cache when LEAK is set, the way a hard-coded path would.
function vaultWithScripts(t) {
  const v = makeVault(t)
  const scripts = {
    'session-start.ts': `const i = JSON.parse(require('fs').readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify({ source: i.source, om_mod: i.om_mod, INDEX_PATH: process.env.INDEX_PATH, QMD_CONFIG_DIR: process.env.QMD_CONFIG_DIR, DEMO: process.env.DEMO }) + '\\n_context injected: 0.1kB / 9.1kB budget_\\n')`,
    'classify-message.ts': `const i = JSON.parse(require('fs').readFileSync(0, 'utf8')); process.stdout.write('prompt: ' + i.prompt)`,
    'validate-write.ts': `const i = JSON.parse(require('fs').readFileSync(0, 'utf8')); process.stdout.write('wrote ' + require('path').basename(i.tool_input.file_path))`,
    'pre-compact.ts': `process.stdout.write('precompact')`,
    'stop-checklist.ts': `const fs = require('fs'), p = require('path'); if (process.env.LEAK) { const d = p.join(process.env.XDG_CACHE_HOME, 'qmd'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(p.join(d, p.basename(process.cwd()) + '.sqlite'), 'x') } process.stdout.write('{}')`,
  }
  // CommonJS, so require works under --experimental-strip-types.
  write(v, '.claude/scripts/package.json', '{"type":"commonjs"}\n')
  for (const [name, body] of Object.entries(scripts)) write(v, `.claude/scripts/${name}`, body + '\n')
  return v
}

const spec = (extra = {}) =>
  validateSpec(
    minimalSpec({
      session: { env: { DEMO: 'from-spec' } },
      scenarios: [
        {
          id: 'd',
          turns: ['hello', '/compact', "Use the Write tool to create 'notes/x.md'. Then say only: done."],
          expect: [
            { id: 'start ran', turn: 'preamble', hook: { event: 'SessionStart', output: 'startup' } },
            { id: 'the model answered', turn: 1, answer: 'never checked dry' },
            { id: 'the user saw it', turn: 1, shown: 'never checked dry' },
          ],
          measures: [{ id: 'answer markers', kind: 'count', turn: 1, in: 'answer', markers: ['a'] }, { id: 'start bytes', kind: 'bytes', turn: 'preamble', in: 'hook:SessionStart' }],
          ...extra,
        },
      ],
    }),
  )

test("a dry run's spawns carry the same qmd redirect a live session gets", (t) => {
  const out = path.join(tmp(t), 'out')
  const record = dryRun({ spec: spec(), vault: vaultWithScripts(t), out })
  const got = JSON.parse(record.runs[0].preamble[0].output.split('\n')[0])
  const want = qmdEnv(path.join(out, 'state', 'd-dry'))
  assert.equal(got.INDEX_PATH, want.INDEX_PATH)
  assert.equal(got.QMD_CONFIG_DIR, want.QMD_CONFIG_DIR)
  assert.equal(got.DEMO, 'from-spec', "the spec's env reaches the scripts too")
})

test('a dry run replays a session: start, then per turn prompt, compaction, the write, Stop', (t) => {
  const out = path.join(tmp(t), 'out')
  const run = dryRun({ spec: spec(), vault: vaultWithScripts(t), out }).runs[0]
  assert.equal(run.arm, 'settings')
  assert.equal(run.preamble[0].name, 'SessionStart:startup')
  assert.deepEqual(run.turns.map((x) => x.hooks.map((h) => h.name)), [
    ['UserPromptSubmit', 'Stop'],
    ['UserPromptSubmit', 'PreCompact', 'SessionStart:compact', 'Stop'],
    ['UserPromptSubmit', 'PostToolUse:Write', 'Stop'],
  ])
  assert.match(run.turns[1].hooks[2].output, /"source":"compact"/)
  assert.equal(run.turns[2].hooks[1].output, 'wrote x.md')
  assert.deepEqual(run.turns[2].tools, ['Write'])
  assert.ok(existsSync(path.join(out, 'beds', 'd-dry', 'notes', 'x.md')))
})

test('a dry run never grades the model layer, and its answer measures record nothing', (t) => {
  const out = path.join(tmp(t), 'out')
  const record = dryRun({ spec: spec(), vault: vaultWithScripts(t), out })
  const g = grade(record, record.specDoc)
  assert.deepEqual(g.rows.map((r) => r.id), ['start ran'])
  assert.equal(g.outcome, 'pass')
  assert.equal(g.measures.find((m) => m.id === 'answer markers').result, null)
  assert.ok(g.measures.find((m) => m.id === 'start bytes').result.value > 0)
  assert.match(renderMarkdown(record, g), /\*\*Dry run:\*\*/)
})

test('a dry hook that writes into the user qmd folders is a leak, and fails the grade', (t) => {
  const out = path.join(tmp(t), 'out')
  const record = dryRun({ spec: spec({ env: { LEAK: '1' } }), vault: vaultWithScripts(t), out })
  const leaks = record.runs[0].residue.leaks
  assert.equal(leaks.length, 1)
  assert.equal(path.basename(leaks[0].file), 'd-dry.sqlite')
  assert.ok(existsSync(leaks[0].file), 'nothing is deleted')
  assert.equal(grade(record, record.specDoc).outcome, 'fail')
})

test('bedEnv: the scenario beats the spec, which beats the redirect, which beats the user', () => {
  const s = validateSpec(minimalSpec({ session: { env: { A: 'spec', INDEX_PATH: 'spec-index' } }, scenarios: [{ id: 's', env: { A: 'scenario' }, turns: ['x'] }] }))
  const env = bedEnv({ base: { A: 'user', QMD_CONFIG_DIR: 'user-config', HOME: 'h' }, stateDir: 'st', spec: s, scenario: s.scenarios[0] })
  assert.equal(env.A, 'scenario')
  assert.equal(env.INDEX_PATH, 'spec-index', 'a spec may still choose its own store')
  assert.equal(env.QMD_CONFIG_DIR, qmdEnv('st').QMD_CONFIG_DIR, "the redirect beats the user's own setting")
  assert.equal(env.HOME, 'h')
})

test('cli: dry grades and exits like run', (t) => {
  const vault = vaultWithScripts(t)
  const dir = tmp(t)
  const specFile = path.join(dir, 'spec.json')
  writeFileSync(specFile, JSON.stringify(minimalSpec({ scenarios: [{ id: 'c', turns: ['x'], expect: [{ id: 'nope', turn: 'preamble', hook: { event: 'SessionStart', output: 'missing' } }] }] })))
  const out = path.join(dir, 'out')
  let code = 0
  try {
    execFileSync(process.execPath, [BIN, 'dry', '--vault', vault, '--spec', specFile, '--out', out], { encoding: 'utf8' })
  } catch (e) {
    code = e.status
  }
  assert.equal(code, 1)
  assert.match(readFileSync(path.join(out, 'results.md'), 'utf8'), /\*\*Dry run:\*\*[\s\S]*\| c \| nope \|/)
})

test('dry --deliver runs SessionStart the way the mod does, beside the settings hooks', async (t) => {
  const { measure, validateMeasure } = await import('../lib/measure.mjs')
  const out = path.join(tmp(t), 'out')
  const run = dryRun({ spec: spec(), vault: vaultWithScripts(t), out, deliver: true }).runs[0]
  const delivered = JSON.parse(run.deliver.output.split('\n')[0])
  assert.equal(delivered.om_mod, 'deliver')
  assert.equal(delivered.INDEX_PATH, qmdEnv(path.join(out, 'state', 'd-dry')).INDEX_PATH, 'the same redirect as every other spawn')
  assert.equal(JSON.parse(run.preamble[0].output.split('\n')[0]).om_mod, undefined, 'the settings SessionStart is untouched')
  assert.equal(run.preamble.length, 1, 'the delivery is not a settings hook')
  const m = validateMeasure({ id: 'x', kind: 'meterSlack', turn: 'preamble', in: 'deliver' }, { arms: ['settings'], turns: 3 }, 'm')
  assert.equal(measure(m, run).value, 9000)
  const plain = dryRun({ spec: spec(), vault: vaultWithScripts(t), out: path.join(tmp(t), 'out2') }).runs[0]
  assert.equal(measure(m, plain), null, 'no delivery recorded means no value, never zero')
})

test('a dry run records hook rows the way a live run does, byte counts included', async (t) => {
  const { summarize } = await import('../lib/results.mjs')
  const out = path.join(tmp(t), 'out')
  const run = dryRun({ spec: spec(), vault: vaultWithScripts(t), out }).runs[0]
  for (const h of [...run.preamble, ...run.turns.flatMap((x) => x.hooks)]) assert.equal(h.outputBytes, Buffer.byteLength(h.output), h.name)
  const text = summarize(run)
  assert.doesNotMatch(text, /undefined/)
  assert.match(text, /UserPromptSubmit: success exit=0 \d+B/)
})

test('a dry run replays an Edit turn: the line changes, then PostToolUse runs on it', (t) => {
  const vault = vaultWithScripts(t)
  const bed = { fixtures: [{ path: 'notes/a.md', content: 'status: completed\n' }] }
  const s = validateSpec(minimalSpec({ bed, scenarios: [{ id: 'e', arms: ['settings'], turns: ["Use the Edit tool on 'notes/a.md': change the line 'status: completed' to 'status: active'. Then say only: done."] }] }))
  const out = path.join(tmp(t), 'out')
  const run = dryRun({ spec: s, vault, out }).runs[0]
  assert.deepEqual(run.turns[0].tools, ['Edit'])
  assert.deepEqual(run.turns[0].hooks.map((h) => h.name), ['UserPromptSubmit', 'PostToolUse:Edit', 'Stop'])
  assert.equal(readFileSync(path.join(out, 'beds', 'e-dry', 'notes', 'a.md'), 'utf8'), 'status: active\n')
  const bad = validateSpec(minimalSpec({ bed, scenarios: [{ id: 'e', arms: ['settings'], turns: ["Use the Edit tool on 'notes/a.md': change the line 'nope' to 'x'."] }] }))
  assert.throws(() => dryRun({ spec: bad, vault, out: path.join(tmp(t), 'out2') }), /has no line "nope"/)
})

test('a dry run skips any expectation that reads the answer or what the user saw, whatever its kind', (t) => {
  const s = validateSpec(
    minimalSpec({
      scenarios: [
        {
          id: 'k',
          arms: ['settings'],
          turns: ['x'],
          expect: [
            { id: 'order in answer', turn: 1, order: { in: 'answer', items: ['a', 'b'] } },
            { id: 'cite in answer', turn: 1, linesCite: { in: 'answer', cite: ['a'] } },
            { id: 'order in hook', turn: 'preamble', order: { in: 'hook:SessionStart', items: ['source', 'INDEX_PATH'] } },
          ],
        },
      ],
    }),
  )
  const record = dryRun({ spec: s, vault: vaultWithScripts(t), out: path.join(tmp(t), 'out') })
  assert.deepEqual(grade(record, record.specDoc).rows.map((r) => [r.id, r.pass]), [['order in hook', true]])
})
