import assert from 'node:assert/strict'
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { grade, renderMarkdown } from '../lib/grade.mjs'
import { diff, qmdEnv, snapshot, userQmdDirs } from '../lib/residue.mjs'
import { runSpec } from '../lib/run.mjs'
import { validateSpec } from '../lib/spec.mjs'
import { FAKE_CLAUDE, makeVault, minimalSpec, tmp, write } from './_helpers.mjs'

test('the user qmd folders follow qmd: XDG first, then the home folder', () => {
  assert.deepEqual(userQmdDirs({ XDG_CACHE_HOME: 'c', XDG_CONFIG_HOME: 'g' }), { cache: path.join('c', 'qmd'), config: path.join('g', 'qmd') })
  assert.deepEqual(userQmdDirs({ HOME: 'h' }), { cache: path.join('h', '.cache', 'qmd'), config: path.join('h', '.config', 'qmd') })
  assert.deepEqual(qmdEnv('run'), { INDEX_PATH: path.join('run', 'qmd', 'index.sqlite'), QMD_CONFIG_DIR: path.join('run', 'qmd', 'config') })
})

test('diff: new entries and the bed\'s own changed entries are leaks; models and others\' changes are not', (t) => {
  const root = tmp(t)
  const dirs = { cache: path.join(root, 'cache'), config: path.join(root, 'config') }
  write(dirs.cache, 'old-bed.sqlite', 'a')
  write(dirs.cache, 'mine-settings.sqlite', 'a')
  write(dirs.cache, 'models/m.gguf', 'a')
  const before = snapshot(dirs)
  assert.ok(!('models' in before.cache.entries), 'the shared models folder is not watched')
  write(dirs.cache, 'mine-settings.sqlite', 'ab')
  write(dirs.cache, 'old-bed.sqlite', 'abc')
  write(dirs.config, 'mine-settings.yml', 'x')
  write(dirs.cache, 'models/new.gguf', 'a')
  const { leaks, touched } = diff(before, snapshot(dirs), 'mine-settings')
  assert.deepEqual(leaks.map((l) => [l.kind, path.basename(l.file), l.change]).sort(), [['cache', 'mine-settings.sqlite', 'changed'], ['config', 'mine-settings.yml', 'created']])
  assert.deepEqual(touched.map((x) => path.basename(x.file)), ['old-bed.sqlite'])
})

test('diff: a same-size rewrite still shows, through its mtime', (t) => {
  const root = tmp(t)
  const dirs = { cache: path.join(root, 'cache') }
  write(dirs.cache, 'bed-x.sqlite', 'aaaa')
  utimesSync(path.join(dirs.cache, 'bed-x.sqlite'), new Date(2020, 0, 1), new Date(2020, 0, 1))
  const before = snapshot(dirs)
  write(dirs.cache, 'bed-x.sqlite', 'bbbb')
  assert.equal(diff(before, snapshot(dirs), 'bed-x').leaks.length, 1)
})

const run = async (t, mode) => {
  const vault = makeVault(t)
  const out = path.join(tmp(t), 'out')
  const spec = validateSpec(minimalSpec({ session: { gapMs: 0, settleMs: 0, turnTimeoutMs: 10000, env: { FAKE_CLAUDE: mode } }, scenarios: [{ id: 'q', arms: ['settings'], turns: ['one'] }] }))
  return { out, record: await runSpec({ spec, vault, out, cmd: FAKE_CLAUDE }) }
}

test('a session that honours INDEX_PATH and QMD_CONFIG_DIR leaves nothing behind', async (t) => {
  const { out, record } = await run(t, 'qmd-good')
  assert.deepEqual(record.runs[0].residue.leaks, [])
  assert.ok(existsSync(path.join(out, 'state', 'q-settings', 'qmd', 'index.sqlite')), 'the store went into the run')
  assert.ok(existsSync(path.join(out, 'state', 'q-settings', 'qmd', 'config', 'q-settings.yml')))
  assert.equal(grade(record, record.specDoc).outcome, 'pass')
})

test('a session that writes into the user qmd folders is a leak: reported, graded fail, never deleted', async (t) => {
  const { record } = await run(t, 'qmd-leak')
  const leaks = record.runs[0].residue.leaks
  assert.deepEqual(leaks.map((l) => [l.kind, path.basename(l.file), l.change]).sort(), [['cache', 'q-settings.sqlite', 'created'], ['config', 'q-settings.yml', 'created']])
  for (const l of leaks) assert.ok(existsSync(l.file), 'the runner deletes nothing')
  const g = grade(record, record.specDoc)
  assert.equal(g.outcome, 'fail')
  assert.match(renderMarkdown(record, g), /Left in the user's qmd folders[\s\S]*q\/settings: created .*q-settings\.sqlite/)
})

test("a change to someone else's store is noted, not a leak", async (t) => {
  write(path.join(process.env.XDG_CACHE_HOME, 'qmd'), 'someone-else.sqlite', 'start')
  const { record } = await run(t, 'qmd-touch')
  assert.deepEqual(record.runs[0].residue.leaks, [])
  assert.equal(record.runs[0].residue.touched.length, 1)
  assert.equal(readFileSync(record.runs[0].residue.touched[0].file, 'utf8'), 'startmore')
})
