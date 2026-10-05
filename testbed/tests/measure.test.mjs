import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compare } from '../lib/compare.mjs'
import { parseMeter, sectionLevel } from '../lib/expect.mjs'
import { MeasureError, measure, validateMeasure } from '../lib/measure.mjs'
import { buildBed } from '../lib/bed.mjs'
import { validateSpec } from '../lib/spec.mjs'
import { SHAPES, northStar } from '../fixtures/north-star/generate.mjs'
import { makeVault, minimalSpec, tmp, write } from './_helpers.mjs'

const ctx = { arms: ['settings', 'mod'], turns: 3 }
const v = (m) => validateMeasure({ id: 'm', ...m }, ctx, 'm')
const hook = (output) => ({ event: 'SessionStart', name: 'SessionStart:startup', status: 'responded', exitCode: 0, output })
const run = (extra = {}) => ({ scenario: 's', arm: 'settings', valid: true, armCheck: { ok: true }, claudeVersion: '2.1.289', preamble: [], turns: [], mod: null, ...extra })
const turn = (index, extra = {}) => ({ index, answer: '', tools: [], toolCalls: [], hooks: [], informational: [], ...extra })

test('parseMeter reads degraded and unknown segments; sectionLevel reads every form', () => {
  // The ladder's real meter (obsidian-mind #308 at 7db990a).
  const ladder = parseMeter('_context injected: 7.5kB / 9.1kB budget — degraded: North Star (current goals) → headlines_')
  assert.deepEqual(ladder.degraded, ['North Star (current goals) → headlines'])
  assert.equal(sectionLevel(ladder, 'North Star (current goals)'), 'headlines')
  assert.equal(sectionLevel(ladder, 'Vault File Listing'), 'full')
  const mixed = parseMeter('_context injected: 8.9kB / 9.1kB budget — degraded: North Star (current goals) → top-N, Recent Changes → focus — collapsed: Vault File Listing — newfangled: x_')
  assert.equal(sectionLevel(mixed, 'North Star (current goals)'), 'top-N')
  assert.equal(sectionLevel(mixed, 'Recent Changes'), 'focus')
  assert.equal(sectionLevel(mixed, 'Vault File Listing'), 'pointer')
  assert.deepEqual(mixed.other, ['newfangled: x'], 'an unknown segment never makes the line unreadable')
  // main's form: a bare name under collapsed: is a pointer.
  const main = parseMeter('_context injected: 0.4kB / 9.1kB budget — collapsed: Vault File Listing, Brain Topics (read on demand), North Star (current goals)_')
  assert.equal(sectionLevel(main, 'North Star (current goals)'), 'pointer')
  assert.equal(sectionLevel(main, 'Brain Topics (read on demand)'), 'pointer')
  assert.equal(sectionLevel(main, 'Brain Topics'), 'full', "a name's parenthetical is part of the name, never a level")
  assert.equal(sectionLevel(parseMeter('_context injected: 1.0kB / 9.1kB budget — collapsed: North Star (current goals) → pointer_'), 'North Star (current goals)'), 'pointer')
  assert.equal(parseMeter('_context injected: soon_'), null)
})

test('count: distinct markers, case-insensitive, out of the list', () => {
  const r = run({ turns: [turn(1, { answer: 'Work on brindlewick, then Corvantine. Brindlewick again.' })] })
  const res = measure(v({ kind: 'count', turn: 1, in: 'answer', markers: ['Brindlewick', 'Corvantine', 'Dashmere'] }), r)
  assert.deepEqual(res, { value: 2, of: 3, named: ['Brindlewick', 'Corvantine'] })
})

test('toolRead: any tool call naming the path, whatever the slashes or case', () => {
  const r = run({ turns: [turn(1), turn(2, { toolCalls: [{ name: 'Read', input: { file_path: 'C:\\vault\\Brain\\North Star.md' } }] })] })
  assert.deepEqual(measure(v({ kind: 'toolRead', path: 'brain/North Star.md' }), r), { value: true, by: 'Read' })
  assert.deepEqual(measure(v({ kind: 'toolRead', turn: 1, path: 'brain/North Star.md' }), r), { value: false })
  const grep = run({ turns: [turn(1, { toolCalls: [{ name: 'Grep', input: { pattern: 'goal', path: 'brain/North Star.md' } }] })] })
  assert.equal(measure(v({ kind: 'toolRead', path: 'brain/North Star.md' }), grep).value, true)
})

test('meterLevel and meterSlack read the last line of the source; bytes counts it', () => {
  const out = '## Session Context\n_context injected: 0.4kB / 9.1kB budget — collapsed: Vault File Listing, North Star (current goals)_\n'
  const r = run({ preamble: [hook(out)] })
  assert.equal(measure(v({ kind: 'meterLevel', turn: 'preamble', in: 'hook:SessionStart', section: 'North Star (current goals)' }), r).value, 'pointer')
  assert.equal(measure(v({ kind: 'meterLevel', turn: 'preamble', in: 'hook:SessionStart', section: 'Brain Topics (read on demand)' }), r).value, 'full')
  assert.equal(measure(v({ kind: 'meterSlack', turn: 'preamble', in: 'hook:SessionStart' }), r).value, 8700)
  assert.equal(measure(v({ kind: 'bytes', turn: 'preamble', in: 'hook:SessionStart' }), r).value, Buffer.byteLength(out))
  assert.equal(measure(v({ kind: 'meterLevel', turn: 'preamble', in: 'hook:SessionStart', section: 'x' }), run({ preamble: [hook('no meter')] })), null)
})

test('a measure on an invalid run or a missing turn is null, never zero', () => {
  const m = v({ kind: 'count', turn: 2, in: 'answer', markers: ['a'] })
  assert.equal(measure(m, run({ valid: false })), null)
  assert.equal(measure(m, run({ turns: [turn(1)] })), null)
})

test('measure validation', () => {
  assert.throws(() => v({ kind: 'nope' }), MeasureError)
  assert.throws(() => v({ kind: 'count', in: 'answer', markers: [] }), /non-empty/)
  assert.throws(() => v({ kind: 'count', in: 'answer', markers: ['a', 'A'] }), /distinct/)
  assert.throws(() => v({ kind: 'count', in: 'stdout', markers: ['a'] }), /in must be/)
  assert.throws(() => v({ kind: 'toolRead' }), /path is required/)
  assert.throws(() => v({ kind: 'meterLevel', in: 'answer' }), /section is required/)
  assert.throws(() => v({ kind: 'bytes', in: 'answer', turn: 9 }), /turn must be/)
  assert.throws(() => validateSpec(minimalSpec({ scenarios: [{ id: 's', turns: ['a'], measures: [{ id: 'x', kind: 'bytes', in: 'answer' }, { id: 'x', kind: 'bytes', in: 'answer' }] }] })), /duplicate id/)
})

test("a scenario's files land after the spec's, so a shape can replace one file", (t) => {
  const dir = tmp(t)
  write(dir, 'f/a.md', 'from bed.files')
  write(dir, 'f/b.md', 'from the scenario')
  const spec = validateSpec(
    minimalSpec({ bed: { files: [{ from: 'f/a.md', path: 'brain/N.md' }] }, scenarios: [{ id: 's', turns: ['x'], files: [{ from: 'f/b.md', path: 'brain/N.md' }] }] }),
    dir,
  )
  const bed = path.join(tmp(t), 'bed')
  buildBed({ vault: makeVault(t), bed, spec, files: spec.scenarios[0].files })
  assert.equal(readFileSync(path.join(bed, 'brain', 'N.md'), 'utf8'), 'from the scenario')
  assert.throws(() => validateSpec(minimalSpec({ scenarios: [{ id: 's', turns: ['x'], files: [{ from: 'nope.md', path: 'a.md' }] }] }), dir), /scenarios\[0\]\.files\[0\]\.from does not exist/)
})

test('compare puts measures and expectation tallies side by side, per label and arm', () => {
  const spec = validateSpec(
    minimalSpec({
      scenarios: [{ id: 's', arms: ['settings'], turns: ['a'], measures: [{ id: 'markers', kind: 'count', turn: 1, in: 'answer', markers: ['A', 'B'] }], expect: [{ id: 'says A', turn: 1, answer: 'A' }] }],
    }),
  )
  const rec = (answer, head) => ({ spec: 'demo', specDoc: spec, vault: { commit: { head: head.repeat(40), dirty: false } }, runs: [run({ turns: [turn(1, { answer })] })] })
  const md = compare([{ label: 'main', record: rec('nothing', 'a') }, { label: 'ladder', record: rec('A and B', 'b') }])
  assert.match(md, /\| \| main · settings \| ladder · settings \|/)
  assert.match(md, /\| markers \| 0\/2 \| 2\/2 \|/)
  assert.match(md, /\| expectations passed \| 0\/1 \(failed: says A\) \| 1\/1 \|/)
  assert.match(md, /\*\*main\*\*: vault aaaaaaa/)
  assert.throws(() => compare([{ label: 'one', record: rec('A', 'a') }]), /two or more/)
  assert.throws(() => compare([{ label: 'a', record: rec('A', 'a') }, { label: 'b', record: { ...rec('A', 'b'), spec: 'other' } }]), /different specs/)
})

test('the North Star fixtures have the shapes the A/B relies on, and match the files on disk', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'north-star')
  const stats = (shape) => {
    const text = northStar(shape)
    assert.equal(readFileSync(path.join(dir, `North Star ${shape}.md`), 'utf8'), text, `North Star ${shape}.md is stale: run generate.mjs`)
    const lines = text.split('\n')
    const live = lines.filter((l) => l.startsWith('- [[Goal')).map((l) => Buffer.byteLength(l)).sort((a, b) => a - b)
    const done = lines.filter((l) => l.startsWith('- \u2705'))
    const focus = text.split('## Current Focus')[1].split('\n## ')[0]
    for (const m of SHAPES[shape].markers) assert.equal(text.split(m).length - 1, 1, `${m} appears exactly once`)
    return { live, done: done.length, focus: Buffer.byteLength(focus) }
  }
  const a = stats('30x380')
  assert.equal(a.live.length, 30)
  assert.ok(a.live.every((n) => n === 380))
  assert.equal(a.done, 0)
  const b = stats('12-live')
  assert.equal(b.live.length, 12)
  assert.equal(b.live.reduce((x, y) => x + y, 0), 8000)
  assert.equal((b.live[5] + b.live[6]) / 2, 626, 'median')
  assert.equal(b.live[11], 1360, 'max')
  assert.equal(b.done, 3)
  assert.ok(b.focus > 12000 && b.focus < 12600, `Current Focus ${b.focus} bytes`)
})
