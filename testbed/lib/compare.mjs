// Several runs side by side: the same spec run against different vaults (a
// branch against main, say), each given a label. One table per scenario:
// a row per measure, plus each run's expectation tally, with a column per
// label and arm.
import { grade } from './grade.mjs'
import { formatValue, measureLabel } from './measure.mjs'

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

// `spec` grades every run against that spec instead of the one stored with
// it: a measure added later is then computed from the same stored runs.
export function compare(labelled, spec = null) {
  if (labelled.length < 2) throw new Error('compare needs two or more labelled results')
  const graded = labelled.map(({ label, record }) => ({ label, record, g: grade(record, spec ?? record.specDoc) }))
  const names = new Set(graded.map((x) => x.record.spec))
  if (names.size !== 1) throw new Error(`these results come from different specs: ${[...names].join(', ')}`)

  const cols = graded.flatMap(({ label, record }) => [...new Set(record.runs.map((r) => r.arm))].map((arm) => ({ label, arm })))
  const out = [`# Compare: ${[...names][0]}`, '']
  for (const { label, record, g } of graded) {
    const versions = [...new Set(record.runs.map((r) => r.claudeVersion).filter(Boolean))].join(', ') || '?'
    const commit = record.vault.commit ? record.vault.commit.head.slice(0, 7) + (record.vault.commit.dirty ? '+' : '') : '?'
    out.push(`- **${label}**: vault ${commit}, Claude Code ${versions}, grade ${g.outcome}`)
  }
  const scenarios = [...new Set(graded.flatMap(({ record }) => record.runs.map((r) => r.scenario)))]
  for (const scenario of scenarios) {
    out.push('', `## ${scenario}`, '', `| | ${cols.map((c) => `${c.label} · ${c.arm}`).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`)
    const ids = [...new Set(graded.flatMap(({ g }) => g.measures.filter((m) => m.scenario === scenario).map((m) => m.id)))]
    for (const id of ids) {
      const cells = cols.map((c) => {
        const r = graded.find((x) => x.label === c.label).g.measures.find((m) => m.scenario === scenario && m.id === id && m.arm === c.arm)
        return r ? formatValue(r.result) : '—'
      })
      const row = graded.flatMap(({ g }) => g.measures).find((m) => m.scenario === scenario && m.id === id)
      out.push(`| ${esc(measureLabel(row))} | ${cells.join(' | ')} |`)
    }
    const tally = cols.map((c) => {
      const rows = graded.find((x) => x.label === c.label).g.rows.filter((r) => r.scenario === scenario && r.arm === c.arm)
      if (rows.length === 0) return '—'
      const failed = rows.filter((r) => r.pass === false).map((r) => r.id)
      return `${rows.length - failed.length}/${rows.length}${failed.length ? ` (failed: ${failed.map(esc).join('; ')})` : ''}`
    })
    out.push(`| expectations passed | ${tally.join(' | ')} |`)
  }
  return out.join('\n') + '\n'
}
