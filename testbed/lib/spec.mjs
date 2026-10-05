// The expectation spec: what a bed is built from and which sessions run in
// it. The runner reads the `bed`, `mod`, `session` and `scenarios` keys;
// expectations per turn are the grader's (testbed/README.md has the format).
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const ARMS = ['settings', 'mod']

// What a bed copies from a vault by default: its agent infrastructure, never
// its notes.
export const DEFAULT_INCLUDE = [
  '.claude',
  '.codex',
  '.gemini',
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'vault-manifest.json',
  '.gitignore',
]

export const DEFAULT_SESSION = {
  model: 'opus',
  maxBudgetUsd: 4,
  allowedTools: [],
  gapMs: 2000,
  settleMs: 5000,
  turnTimeoutMs: 180000,
  env: {},
}

export class SpecError extends Error {}

// A path the spec names inside the bed: relative, POSIX, and never leaving it.
export function bedPath(p, where) {
  if (typeof p !== 'string' || p === '') throw new SpecError(`${where}: path must be a non-empty string`)
  if (p.includes('\\')) throw new SpecError(`${where}: use / in paths, got ${p}`)
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) throw new SpecError(`${where}: path must be relative, got ${p}`)
  const norm = path.posix.normalize(p)
  if (norm === '..' || norm.startsWith('../')) throw new SpecError(`${where}: path leaves the bed: ${p}`)
  return norm
}

function checkFixture(f, where) {
  bedPath(f.path, where)
  const kinds = ['content', 'fill'].filter((k) => k in f)
  if (kinds.length !== 1) throw new SpecError(`${where}: give exactly one of content or fill`)
  if ('fill' in f && !(Number.isInteger(f.fill) && f.fill >= 0)) throw new SpecError(`${where}: fill must be a byte count`)
}

function checkAction(a, where) {
  if ('append' in a) {
    bedPath(a.append, where)
    if (!(Number.isInteger(a.bytes) && a.bytes > 0)) throw new SpecError(`${where}: append needs a positive bytes count`)
  } else if ('write' in a) {
    bedPath(a.write, where)
    if (typeof a.content !== 'string') throw new SpecError(`${where}: write needs content`)
  } else {
    throw new SpecError(`${where}: unknown action ${JSON.stringify(a)}`)
  }
}

// Turns are strings, or { text, before: [actions] }.
export function normalizeTurn(t, where) {
  const turn = typeof t === 'string' ? { text: t, before: [] } : { before: [], ...t }
  if (typeof turn.text !== 'string' || turn.text === '') throw new SpecError(`${where}: turn needs text`)
  turn.before.forEach((a, i) => checkAction(a, `${where}.before[${i}]`))
  return turn
}

export function validateSpec(raw) {
  if (!raw || typeof raw !== 'object') throw new SpecError('spec must be a JSON object')
  if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.name)) {
    throw new SpecError('spec.name must be lowercase letters, digits and dashes')
  }
  const bed = { include: DEFAULT_INCLUDE, copy: [], fixtures: [], ...raw.bed }
  bed.include.forEach((p, i) => p === '.' || bedPath(p, `bed.include[${i}]`))
  bed.copy.forEach((p, i) => bedPath(p, `bed.copy[${i}]`))
  bed.fixtures.forEach((f, i) => checkFixture(f, `bed.fixtures[${i}]`))

  const mod = raw.mod ? { ...raw.mod } : null
  if (mod) {
    bedPath(mod.dir, 'mod.dir')
    mod.name ??= path.posix.basename(mod.dir)
  }

  const session = { ...DEFAULT_SESSION, ...raw.session }
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) throw new SpecError('spec.scenarios must be a non-empty array')
  const ids = new Set()
  const scenarios = raw.scenarios.map((s, i) => {
    const where = `scenarios[${i}]`
    if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) throw new SpecError(`${where}.id must be lowercase letters, digits and dashes`)
    if (ids.has(s.id)) throw new SpecError(`${where}: duplicate id ${s.id}`)
    ids.add(s.id)
    const arms = s.arms ?? ARMS
    for (const a of arms) if (!ARMS.includes(a)) throw new SpecError(`${where}: unknown arm ${a}`)
    if (arms.includes('mod') && !mod) throw new SpecError(`${where}: the mod arm needs spec.mod`)
    if (!Array.isArray(s.turns) || s.turns.length === 0) throw new SpecError(`${where}.turns must be a non-empty array`)
    const turns = s.turns.map((t, j) => normalizeTurn(t, `${where}.turns[${j}]`))
    return { ...s, arms, turns }
  })
  return { ...raw, bed, mod, session, scenarios }
}

export function loadSpec(file) {
  return validateSpec(JSON.parse(readFileSync(file, 'utf8')))
}
