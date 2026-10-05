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
    'session-start.ts': `const i = JSON.parse(require('fs').readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify({ source: i.source, INDEX_PATH: process.env.INDEX_PATH, QMD_CONFIG_DIR: process.env.QMD_CONFIG_DIR, DEMO: process.env.DEMO }) + '\\n_context injected: 0.1kB / 9.1kB budget_\\n')`,
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
