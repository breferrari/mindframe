// Grades a results.json against the expectations in its spec, and renders
// the two tables a run is read by: expectations by arm, and every hook by
// arm.
import { DRY_SKIPPED } from './dry.mjs'
import { evaluate, silent } from './expect.mjs'
import { formatValue, measureAll, measureLabel } from './measure.mjs'

// An expectation of any kind that reads the model's answer or what the user
// was shown (order over the answer, linesCite, …) needs a live session.
const readsModel = (e) => ['answer', 'shown'].includes(e[e.kind]?.in)
// The mod's startup delivery exists only in a dry run with --deliver.
const readsDeliver = (e) => e[e.kind]?.in === 'deliver'

// `requireDeliver`: a dry run that recorded no delivery fails each delivery
// row instead of leaving it ungraded. CI sets it, so a delivery that goes
// missing can't pass quietly.
export function grade(record, spec, verdicts = {}, { requireDeliver = false } = {}) {
  const rows = []
  // What a dry run could not check, by name and why, so a dry pass never
  // reads as full coverage (DESIGN.md rule 10).
  const notGraded = []
  for (const s of spec.scenarios) {
    const ran = record.runs.some((r) => r.scenario === s.id)
    for (const e of s.expect ?? []) {
      // The delivery is graded against the dry run that recorded it, as the
      // mod arm it describes. With none recorded the row is left out and
      // named, never failed for an empty source, unless requireDeliver.
      if (readsDeliver(e)) {
        if (!ran) continue
        if (!record.dry) {
          notGraded.push({ scenario: s.id, id: e.id, why: 'dry only' })
          continue
        }
        for (const run of record.runs.filter((r) => r.scenario === s.id)) {
          if (run.deliver) rows.push({ scenario: s.id, ...evaluate(e, run, verdicts), arm: 'mod' })
          else if (requireDeliver) rows.push({ scenario: s.id, id: e.id, kind: e.kind, turn: e.turn, arm: 'mod', pass: false, detail: 'no delivery recorded: run dry with --deliver' })
          else notGraded.push({ scenario: s.id, id: e.id, why: 'dry --deliver only' })
        }
        continue
      }
      // A dry run has no model and no Claude Code: those rows aren't graded.
      if (record.dry && ran && !e.arms.includes('settings')) {
        notGraded.push({ scenario: s.id, id: e.id, why: 'mod arm' })
        continue
      }
      if (record.dry && ran && (DRY_SKIPPED.has(e.kind) || readsModel(e))) {
        notGraded.push({ scenario: s.id, id: e.id, why: 'model layer' })
        continue
      }
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
  return { rows, invalid, leaks, failed, pending, passed: rows.length - failed - pending, outcome, notGraded, measures: measureAll(record, spec) }
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
      else if (silent(h)) c.silent++
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
  if (record.dry) out.push('**Dry run:** the hook scripts ran directly, with no model and no Claude Code, on the settings arm. Answers, what the user is shown, judged rows and mod events are not graded. The mod\'s delivery is, as the mod arm, when the run recorded it (--deliver).', '')
  if (graded.notGraded?.length) {
    const by = (why) => graded.notGraded.filter((n) => n.why === why).length
    const mode = record.dry ? 'dry' : 'live'
    const counts = [
      [by('model layer'), 'model layer'],
      [by('mod arm'), 'mod arm only'],
      [by('dry --deliver only') + by('dry only'), "the mod's delivery"],
    ].filter(([n], k) => n > 0 || (record.dry && k < 2))
    out.push(`**${graded.notGraded.length} expectations not graded in ${mode === 'dry' ? 'dry' : 'a live run'}** (${counts.map(([n, what]) => `${n} ${what}`).join(', ')}). A ${mode} pass covers the rest:`, '')
    for (const n of graded.notGraded) out.push(`- ${n.scenario}: ${esc(n.id)} (${n.why})`)
    out.push('')
  }
  const cost = record.runs.reduce((n, r) => n + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0)
  out.push(`Claude Code ${versions.join(', ') || 'unknown'} · vault ${record.vault.commit ? record.vault.commit.head.slice(0, 7) + (record.vault.commit.dirty ? ' (uncommitted changes)' : '') : 'not a git repo'} · ${record.runs.length} sessions${cost > 0 ? ` · $${cost.toFixed(2)}` : ''}`, '')
  out.push(`**${graded.outcome.toUpperCase()}**: ${graded.passed} passed, ${graded.failed} failed, ${graded.pending} awaiting the blind grader${graded.invalid.length ? `; invalid runs: ${graded.invalid.join(', ')}` : ''}`, '')
  if (graded.leaks?.length) {
    const procs = graded.leaks.filter((l) => l.kind === 'process')
    const files = graded.leaks.filter((l) => l.kind !== 'process')
    for (const [list, head] of [
      [files, "**Left in the user's qmd folders** (a leak fails the grade; nothing was deleted):"],
      [procs, '**Processes the run left running** (a leftover fails the grade; nothing was killed):'],
    ]) {
      if (!list.length) continue
      out.push(head, '')
      for (const l of list) out.push(`- ${l.run}: ${l.change} ${l.file}`)
      out.push('')
    }
  }
  if (graded.outcome === 'incomplete') out.push('Not a pass: the blind grader has not ruled on every judged answer. Run `bed.mjs judge prepare`, then `judge apply`.', '')

  // A dry run's delivery rows are graded as the mod arm, which it never ran.
  const arms = [...new Set([...record.runs.map((r) => r.arm), ...graded.rows.map((r) => r.arm)])]
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
