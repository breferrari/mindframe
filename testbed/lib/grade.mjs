// Grades a results.json against the expectations in its spec, and renders
// the two tables a run is read by: expectations by arm, and every hook by
// arm.
import { DRY_SKIPPED } from './dry.mjs'
import { evaluate } from './expect.mjs'
import { formatValue, measureAll, measureLabel } from './measure.mjs'

export function grade(record, spec, verdicts = {}) {
  const rows = []
  for (const s of spec.scenarios) {
    for (const e of s.expect ?? []) {
      // A dry run has no model and no Claude Code: those rows aren't graded.
      if (record.dry && DRY_SKIPPED.has(e.kind)) continue
      for (const arm of e.arms) {
        const run = record.runs.find((r) => r.scenario === s.id && r.arm === arm)
        if (!run) continue // not run this time (--arm, --scenario)
        rows.push({ scenario: s.id, arm, ...evaluate(e, run, verdicts) })
      }
    }
  }
  const invalid = record.runs.filter((r) => !r.valid).map((r) => `${r.scenario}/${r.arm}`)
  const leaks = record.runs.flatMap((r) => (r.residue?.leaks ?? []).map((l) => ({ run: `${r.scenario}/${r.arm}`, ...l })))
  const failed = rows.filter((r) => r.pass === false).length
  const pending = rows.filter((r) => r.pass === null).length
  // A grade that skipped what it couldn't check is not a pass: pending
  // judge rows make it incomplete, never passed.
  const outcome = failed > 0 || invalid.length > 0 || leaks.length > 0 ? 'fail' : pending > 0 ? 'incomplete' : 'pass'
  // Measures are recorded beside the grade and never change its outcome.
  return { rows, invalid, leaks, failed, pending, passed: rows.length - failed - pending, outcome, measures: measureAll(record, spec) }
}

// pass 0, fail 1, incomplete 3 (2 is the command line's usage error).
export const EXIT = { pass: 0, fail: 1, incomplete: 3 }

// Every hook the runs saw, by event and arm: how many times it ran, and how
// many of those did not end with exit 0.
export function hookTable(record) {
  const arms = [...new Set(record.runs.map((r) => r.arm))]
  const cells = {}
  for (const run of record.runs) {
    for (const h of [...run.preamble, ...run.turns.flatMap((t) => t.hooks)]) {
      const c = ((cells[h.event] ??= {})[run.arm] ??= { ran: 0, failed: 0, silent: 0 })
      c.ran++
      if (h.status !== 'responded' || h.exitCode !== 0) c.failed++
      else if (String(h.output ?? '').trim() === '' || String(h.output).trim() === '{}') c.silent++
    }
  }
  const mod = {}
  for (const run of record.runs) {
    for (const t of run.mod?.timings ?? []) {
      const c = (mod[t.event] ??= { n: 0, maxMs: 0 })
      c.n++
      c.maxMs = Math.max(c.maxMs, t.ms)
    }
  }
  return { arms, cells, mod }
}

const mark = (p) => (p === true ? '✅' : p === false ? '❌' : '⏳')
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function renderMarkdown(record, graded) {
  const out = []
  const versions = [...new Set(record.runs.map((r) => r.claudeVersion).filter(Boolean))]
  out.push(`# Test bed: ${record.spec}`, '')
  if (record.dry) out.push('**Dry run:** the hook scripts ran directly, with no model and no Claude Code, on the settings arm. Answers, what the user is shown, judged rows and mod events are not graded.', '')
  out.push(`Claude Code ${versions.join(', ') || 'unknown'} · vault ${record.vault.commit ? record.vault.commit.head.slice(0, 7) + (record.vault.commit.dirty ? ' (uncommitted changes)' : '') : 'not a git repo'} · ${record.runs.length} sessions`, '')
  out.push(`**${graded.outcome.toUpperCase()}**: ${graded.passed} passed, ${graded.failed} failed, ${graded.pending} awaiting the blind grader${graded.invalid.length ? `; invalid runs: ${graded.invalid.join(', ')}` : ''}`, '')
  if (graded.leaks?.length) {
    out.push("**Left in the user's qmd folders** (a leak fails the grade; nothing was deleted):", '')
    for (const l of graded.leaks) out.push(`- ${l.run}: ${l.change} ${l.file}`)
    out.push('')
  }
  if (graded.outcome === 'incomplete') out.push('Not a pass: the blind grader has not ruled on every judged answer. Run `bed.mjs judge prepare`, then `judge apply`.', '')

  const arms = [...new Set(record.runs.map((r) => r.arm))]
  out.push('## Expectations', '')
  out.push(`| Scenario | Expectation | Turn | ${arms.join(' | ')} |`, `|---|---|---|${arms.map(() => '---').join('|')}|`)
  const keys = [...new Set(graded.rows.map((r) => `${r.scenario}\u0000${r.id}`))]
  for (const k of keys) {
    const [scenario, id] = k.split('\u0000')
    const rs = graded.rows.filter((r) => r.scenario === scenario && r.id === id)
    const cells = arms.map((a) => {
      const r = rs.find((x) => x.arm === a)
      if (!r) return '—'
      return r.pass === true ? mark(true) : `${mark(r.pass)} ${esc(r.detail)}`
    })
    out.push(`| ${scenario} | ${esc(id)} | ${rs[0].turn ?? ''} | ${cells.join(' | ')} |`)
  }

  if (graded.measures?.length) {
    out.push('', '## Measures', '', 'Recorded, not graded. Compare runs with `bed.mjs compare`.', '')
    out.push(`| Scenario | Measure | ${arms.join(' | ')} |`, `|---|---|${arms.map(() => '---').join('|')}|`)
    const keys = [...new Set(graded.measures.map((r) => `${r.scenario}\u0000${r.id}`))]
    for (const k of keys) {
      const [scenario, id] = k.split('\u0000')
      const cells = arms.map((a) => {
        const r = graded.measures.find((x) => x.scenario === scenario && x.id === id && x.arm === a)
        return r ? formatValue(r.result) : '—'
      })
      const row = graded.measures.find((x) => x.scenario === scenario && x.id === id)
      out.push(`| ${scenario} | ${esc(measureLabel(row))} | ${cells.join(' | ')} |`)
    }
  }

  const ht = hookTable(record)
  out.push('', '## Hooks', '', 'Times run, and how many did not end with exit 0. Silent: ran with no output for the model or the user.', '')
  out.push(`| Hook | ${ht.arms.join(' | ')} |`, `|---|${ht.arms.map(() => '---').join('|')}|`)
  for (const [event, byArm] of Object.entries(ht.cells)) {
    const cells = ht.arms.map((a) => {
      const c = byArm[a]
      if (!c) return '—'
      return `${c.ran} ran${c.failed ? `, **${c.failed} failed**` : ''}${c.silent ? `, ${c.silent} silent` : ''}`
    })
    out.push(`| ${event} | ${cells.join(' | ')} |`)
  }
  if (Object.keys(ht.mod).length) {
    out.push('', '## Mod events', '', '| Event | Settled | Slowest |', '|---|---|---|')
    for (const [event, c] of Object.entries(ht.mod)) out.push(`| ${event} | ${c.n} | ${c.maxMs} ms |`)
  }
  return out.join('\n') + '\n'
}
