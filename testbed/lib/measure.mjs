// Measures: what a run records rather than passes or fails. An A/B compares
// these across arms and vaults (bed.mjs compare); an expectation would only
// say whether one arm cleared a bar.
//
// Kinds, each with an optional `turn` (a number, "preamble" or "any"; default
// "any") and `arms`:
//   count      { in, markers }   how many distinct markers the source names
//                                (case-insensitive), out of markers.length
//   toolRead   { path }          whether any tool call's file, path, pattern or
//                                command mentions the path
//   meterLevel { in, section }   the section's level in the meter: full, a
//                                named level, or pointer; null with no meter
//   meterSlack { in }            the budget the meter says went unused: its
//                                budget minus the size it reports
//   bytes      { in }            the source's size in bytes
import { parseMeter, sectionLevel, sourceText } from './expect.mjs'

export const MEASURE_KINDS = ['count', 'toolRead', 'meterLevel', 'meterSlack', 'bytes']

export class MeasureError extends Error {}

const SOURCE = /^(answer|shown|hook:[A-Za-z]+)$/

export function validateMeasure(m, { arms, turns }, where) {
  if (typeof m.id !== 'string' || m.id === '') throw new MeasureError(`${where}.id is required`)
  if (!MEASURE_KINDS.includes(m.kind)) throw new MeasureError(`${where}.kind must be one of ${MEASURE_KINDS.join(', ')}`)
  const turn = m.turn ?? 'any'
  if (!(turn === 'any' || turn === 'preamble' || (Number.isInteger(turn) && turn >= 1 && turn <= turns))) {
    throw new MeasureError(`${where}.turn must be 1..${turns}, "preamble" or "any"`)
  }
  const out = { ...m, turn, arms: m.arms ?? arms }
  for (const a of out.arms) if (!arms.includes(a)) throw new MeasureError(`${where}: arm ${a} is not one of the scenario's arms`)
  if (m.kind !== 'toolRead' && !SOURCE.test(m.in ?? '')) throw new MeasureError(`${where}.in must be answer, shown or hook:<Event>`)
  if (m.kind === 'count' && !(Array.isArray(m.markers) && m.markers.length > 0 && m.markers.every((x) => typeof x === 'string' && x !== ''))) {
    throw new MeasureError(`${where}.markers must be a non-empty list of words`)
  }
  if (m.kind === 'count' && new Set(m.markers.map((x) => x.toLowerCase())).size !== m.markers.length) throw new MeasureError(`${where}.markers must be distinct`)
  if (m.kind === 'toolRead' && (typeof m.path !== 'string' || m.path === '')) throw new MeasureError(`${where}.path is required`)
  if (m.kind === 'meterLevel' && (typeof m.section !== 'string' || m.section === '')) throw new MeasureError(`${where}.section is required`)
  return out
}

const preambleOf = (run) => ({ index: 'preamble', hooks: run.preamble, answer: '', informational: [], tools: [], toolCalls: [] })

function turnsFor(run, turn) {
  if (turn === 'preamble') return [preambleOf(run)]
  if (turn === 'any') return [preambleOf(run), ...run.turns]
  return run.turns.filter((t) => t.index === turn)
}

const norm = (s) => s.replace(/\\/g, '/').toLowerCase()

// The value of one measure on one run; null when the run can't say (an
// invalid run, a missing turn, no meter).
export function measure(m, run) {
  if (!run.valid) return null
  // A dry run has no answers and no model-made tool calls to measure.
  if (run.dry && (m.kind === 'toolRead' || m.in === 'answer')) return null
  const ts = turnsFor(run, m.turn)
  if (ts.length === 0) return null
  if (m.kind === 'count') {
    const text = ts.map((t) => sourceText(t, m.in)).join('\n').toLowerCase()
    const named = m.markers.filter((x) => text.includes(x.toLowerCase()))
    return { value: named.length, of: m.markers.length, named }
  }
  if (m.kind === 'toolRead') {
    const want = norm(m.path)
    const hit = ts.flatMap((t) => t.toolCalls ?? []).find((c) => Object.values(c.input ?? {}).some((v) => norm(v).includes(want)))
    return { value: hit !== undefined, ...(hit ? { by: hit.name } : {}) }
  }
  if (m.kind === 'meterLevel' || m.kind === 'meterSlack') {
    for (const t of ts) {
      const text = sourceText(t, m.in)
      if (text === '') continue
      const meter = parseMeter(text.trimEnd().split('\n').pop())
      if (!meter) continue
      if (m.kind === 'meterLevel') return { value: sectionLevel(meter, m.section) }
      return meter.budget === null ? null : { value: meter.budget - meter.bytes }
    }
    return null
  }
  if (m.kind === 'bytes') return { value: ts.reduce((n, t) => n + Buffer.byteLength(sourceText(t, m.in)), 0) }
  throw new MeasureError(`unknown kind ${m.kind}`)
}

// Every measure of the spec on every run it applies to.
export function measureAll(record, spec) {
  const rows = []
  for (const s of spec.scenarios) {
    for (const m of s.measures ?? []) {
      for (const arm of m.arms) {
        const run = record.runs.find((r) => r.scenario === s.id && r.arm === arm)
        if (run) rows.push({ scenario: s.id, arm, id: m.id, kind: m.kind, result: measure(m, run) })
      }
    }
  }
  return rows
}

export function formatValue(result) {
  if (result === null) return '—'
  if ('of' in result) return `${result.value}/${result.of}`
  if (typeof result.value === 'boolean') return result.value ? `yes (${result.by})` : 'no'
  return String(result.value)
}
