import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { buildBed, infrastructureFiles, vaultCommit } from '../lib/bed.mjs'
import { validateSpec } from '../lib/spec.mjs'
import { makeVault, minimalSpec, tmp } from './_helpers.mjs'

const at = (root, rel) => path.join(root, ...rel.split('/'))

test('a bed holds infrastructure, uncommitted work and fixtures, never notes or ignored state', (t) => {
  const vault = makeVault(t)
  const bed = path.join(tmp(t), 'bed1')
  const spec = validateSpec(
    minimalSpec({
      bed: {
        copy: ['.claude/scripts/node_modules'],
        fixtures: [
          { path: 'work/active/Done.md', content: '---\nstatus: completed\n---\n' },
          { path: 'notes/Big.md', header: 'head\n', fill: 100 },
        ],
      },
    }),
  )
  buildBed({ vault, bed, spec })

  assert.ok(existsSync(at(bed, 'vault-manifest.json')))
  assert.ok(existsSync(at(bed, 'CLAUDE.md')))
  assert.ok(existsSync(at(bed, '.claude/settings.json')))
  assert.ok(existsSync(at(bed, '.claude/scripts/new-hook.ts')), 'untracked work is copied')
  assert.ok(existsSync(at(bed, '.claude/scripts/node_modules/dep/index.js')), 'bed.copy is copied')
  assert.ok(!existsSync(at(bed, 'notes/private.md')), 'notes stay out')
  assert.ok(!existsSync(at(bed, 'brain')), 'note folders stay out')
  assert.ok(!existsSync(at(bed, '.claude/state.json')), 'ignored state stays out')

  assert.equal(readFileSync(at(bed, 'work/active/Done.md'), 'utf8'), '---\nstatus: completed\n---\n')
  assert.equal(statSync(at(bed, 'notes/Big.md')).size, 'head\n'.length + 100)

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: bed, encoding: 'utf8' })
  assert.equal(status, '', 'fixtures are committed')
  const log = execFileSync('git', ['log', '--oneline'], { cwd: bed, encoding: 'utf8' }).trim().split('\n')
  assert.equal(log.length, 1)
})

test('node_modules never comes through the file list, only through bed.copy', (t) => {
  const vault = makeVault(t)
  execFileSync('git', ['add', '-f', '.claude/scripts/node_modules'], { cwd: vault })
  const files = infrastructureFiles(vault, ['.claude'])
  assert.ok(files.includes('.claude/scripts/hook.ts'))
  assert.ok(!files.some((f) => f.includes('node_modules')))
})

test("include '.' copies the whole tree", (t) => {
  const vault = makeVault(t)
  const files = infrastructureFiles(vault, ['.'])
  assert.ok(files.includes('notes/private.md'))
})

test('the builder refuses a folder that exists', (t) => {
  const vault = makeVault(t)
  const bed = path.join(tmp(t), 'bed1')
  mkdirSync(bed)
  assert.throws(() => buildBed({ vault, bed, spec: validateSpec(minimalSpec()) }), /exists/)
})

test('vaultCommit records head and dirtiness, null outside git', (t) => {
  const vault = makeVault(t)
  const c = vaultCommit(vault)
  assert.match(c.head, /^[0-9a-f]{40}$/)
  assert.equal(c.dirty, true)
  assert.equal(vaultCommit(tmp(t)), null)
})
