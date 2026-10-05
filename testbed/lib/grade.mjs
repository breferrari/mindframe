// Grades a results.json against the expectations in its spec, and renders
// the two tables a run is read by: expectations by arm, and every hook by
// arm.
import { evaluate } from './expect.mjs'

export function grade(record, spec, verdicts = {}) {
  const rows = []
  for (const s of spec.scenarios) {
    for (const e of s.expect ?? []) {
      for (const arm of e.arms) {
        const run = record.runs.find((r) => r.scenario === s.id && r.arm === arm)
        if (!run) continue // not run this time (--arm, --scenario)
        rows.push({ scenario: s.id, arm, ...evaluate(e, run, verdicts) })
      }
    }
  }
  const invalid = record.runs.filter((r) => !r.valid).map((r) => `${r.scenario}/${r.arm}`)
  const failed = rows.filter((r) => r.pass === false).length
  const pending = rows.filter((r) => r.pass === null).length
  return { rows, invalid, failed, pending, passed: rows.length - failed - pending, ok: failed === 0 && invalid.length === 0 }
}

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
  out.push(`Claude Code ${versions.join(', ') || 'unknown'} · vault ${record.vault.commit ? record.vault.commit.head.slice(0, 7) + (record.vault.commit.dirty ? ' (uncommitted changes)' : '') : 'not a git repo'} · ${record.runs.length} sessions`, '')
  out.push(`**${graded.ok ? 'PASS' : 'FAIL'}**: ${graded.passed} passed, ${graded.failed} failed, ${graded.pending} awaiting the blind grader${graded.invalid.length ? `; invalid runs: ${graded.invalid.join(', ')}` : ''}`, '')

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
