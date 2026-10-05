#!/usr/bin/env node
// CI's dry run of every shipped spec, against pinned vault commits
// (testbed/ci/pins.json). No model and no Claude Code: each vault's own hook
// scripts run as a session would run them, with the same qmd redirect and
// residue check as any bed run (lib/dry.mjs). Deterministic, so it gates CI;
// live sessions never do.
//
//   node testbed/bin/ci-dry.mjs [--work <dir>]
//
// Exit 0 when every spec's dry grade passes, 1 otherwise.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { dryRun } from '../lib/dry.mjs'
import { grade, renderMarkdown } from '../lib/grade.mjs'
import { loadSpec } from '../lib/spec.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { work: { type: 'string' } } })
const work = path.resolve(values.work ?? path.join(os.tmpdir(), `mindframe-ci-dry-${Date.now()}`))
mkdirSync(work, { recursive: true })

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()

// One shallow fetch of the pinned commit per vault. A short SHA is resolved
// by a fetch of the default branch's history when GitHub won't serve it.
function checkout(name, { repository, commit }) {
  const dir = path.join(work, 'vaults', name)
  if (existsSync(dir)) return dir
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'remote', 'add', 'origin', repository)
  try {
    git(dir, 'fetch', '-q', '--depth', '1', 'origin', commit)
    git(dir, 'checkout', '-q', 'FETCH_HEAD')
  } catch {
    git(dir, 'fetch', '-q', '--filter=blob:none', 'origin')
    git(dir, 'checkout', '-q', commit)
  }
  const head = git(dir, 'rev-parse', 'HEAD')
  if (!head.startsWith(commit)) throw new Error(`${name}: checked out ${head}, wanted ${commit}`)
  return dir
}

const pins = JSON.parse(readFileSync(path.join(ROOT, 'ci', 'pins.json'), 'utf8'))
let failed = 0
for (const { spec: name, vault } of pins.specs) {
  const pin = pins.vaults[vault]
  const dir = checkout(vault, pin)
  const spec = loadSpec(path.join(ROOT, 'specs', `${name}.json`))
  const record = dryRun({ spec, vault: dir, out: path.join(work, 'out', name) })
  const graded = grade(record, spec)
  console.log(`\n### ${name} on ${vault} ${pin.commit}: ${graded.outcome.toUpperCase()}\n`)
  console.log(renderMarkdown(record, graded))
  if (graded.outcome !== 'pass') failed++
}
console.log(failed ? `\n${failed} spec(s) failed their dry grade` : '\nevery spec passed its dry grade')
process.exitCode = failed ? 1 : 0
