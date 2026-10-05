// The expectation spec: what a bed is built from and which sessions run in
// it. The runner reads the `bed`, `mod`, `session` and `scenarios` keys;
// expectations per turn are the grader's (testbed/README.md has the format).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ExpectError, validateExpectation } from './expect.mjs'
import { MeasureError, validateMeasure } from './measure.mjs'

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

// A string-valued object, for environment variables.
function checkEnv(env, where) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new SpecError(`${where} must be an object`)
  for (const [k, v] of Object.entries(env)) if (typeof v !== 'string') throw new SpecError(`${where}.${k} must be a string`)
}

// bed.files copies files from the repo into the bed. `from` is relative to
// the spec file, so a spec can use fixtures beside it; it is resolved and
// checked once, at load.
function checkFiles(files, baseDir) {
  if (!Array.isArray(files)) throw new SpecError('bed.files must be an array')
  return files.map((f, i) => {
    const where = `bed.files[${i}]`
    bedPath(f.path, `${where}.path`)
    if (typeof f.from !== 'string' || f.from === '' || path.isAbsolute(f.from)) throw new SpecError(`${where}.from must be a path relative to the spec file`)
    const source = path.resolve(baseDir, ...f.from.split('/'))
    if (!existsSync(source)) throw new SpecError(`${where}.from does not exist: ${f.from}`)
    return { ...f, source }
  })
}

// bed.manifest edits the bed's vault-manifest.json: `set` replaces
// top-level keys, `extensions` appends declarations to the manifest's own.
function checkManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new SpecError('bed.manifest must be an object')
  for (const k of Object.keys(m)) if (k !== 'set' && k !== 'extensions') throw new SpecError(`bed.manifest: unknown key ${k}`)
  if (m.set !== undefined && (typeof m.set !== 'object' || Array.isArray(m.set) || m.set === null)) throw new SpecError('bed.manifest.set must be an object')
  if (m.set && 'extensions' in m.set) throw new SpecError('bed.manifest.set may not replace extensions; append with bed.manifest.extensions')
  if (m.extensions !== undefined) {
    if (!Array.isArray(m.extensions)) throw new SpecError('bed.manifest.extensions must be an array')
    m.extensions.forEach((d, i) => {
      if (!d || typeof d.id !== 'string') throw new SpecError(`bed.manifest.extensions[${i}] needs an id`)
    })
  }
  return { set: m.set ?? {}, extensions: m.extensions ?? [] }
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

export function validateSpec(raw, baseDir = process.cwd()) {
  if (!raw || typeof raw !== 'object') throw new SpecError('spec must be a JSON object')
  if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.name)) {
    throw new SpecError('spec.name must be lowercase letters, digits and dashes')
  }
  const bed = { include: DEFAULT_INCLUDE, copy: [], fixtures: [], ...raw.bed }
  bed.include.forEach((p, i) => p === '.' || bedPath(p, `bed.include[${i}]`))
  bed.copy.forEach((p, i) => bedPath(p, `bed.copy[${i}]`))
  bed.fixtures.forEach((f, i) => checkFixture(f, `bed.fixtures[${i}]`))
  bed.files = checkFiles(bed.files ?? [], baseDir)
  bed.manifest = raw.bed?.manifest === undefined ? null : checkManifest(raw.bed.manifest)

  const mod = raw.mod ? { ...raw.mod } : null
  if (mod) {
    bedPath(mod.dir, 'mod.dir')
    mod.name ??= path.posix.basename(mod.dir)
  }

  const session = { ...DEFAULT_SESSION, ...raw.session }
  checkEnv(session.env, 'session.env')
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
    if (s.env !== undefined) checkEnv(s.env, `${where}.env`)
    // Files for this scenario's bed only, copied after bed.files, so two
    // scenarios can differ in one file and share everything else.
    let files
    try {
      files = checkFiles(s.files ?? [], baseDir)
    } catch (err) {
      throw err instanceof SpecError ? new SpecError(err.message.replace('bed.files', `${where}.files`)) : err
    }
    const expectIds = new Set()
    const expect = (s.expect ?? []).map((e, j) => {
      const w = `${where}.expect[${j}]`
      try {
        const out = validateExpectation(e, { arms, turns: turns.length }, w)
        if (expectIds.has(out.id)) throw new ExpectError(`${w}: duplicate id ${out.id}`)
        expectIds.add(out.id)
        return out
      } catch (err) {
        throw err instanceof ExpectError ? new SpecError(err.message) : err
      }
    })
    const measureIds = new Set()
    const measures = (s.measures ?? []).map((m, j) => {
      const w = `${where}.measures[${j}]`
      try {
        const out = validateMeasure(m, { arms, turns: turns.length }, w)
        if (measureIds.has(out.id)) throw new MeasureError(`${w}: duplicate id ${out.id}`)
        measureIds.add(out.id)
        return out
      } catch (err) {
        throw err instanceof MeasureError ? new SpecError(err.message) : err
      }
    })
    return { ...s, arms, turns, files, expect, measures }
  })
  return { ...raw, bed, mod, session, scenarios }
}

export function loadSpec(file) {
  return validateSpec(JSON.parse(readFileSync(file, 'utf8')), path.dirname(path.resolve(file)))
}
