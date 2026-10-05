// Rebuilds a finished run's results from its raw logs with the current
// parser: a parser fix then applies to sessions already paid for, with no
// new ones. What only the run itself knew is kept as recorded: the exit
// code, the feed and the residue snapshots. The previous results.json is
// kept beside the new one, never overwritten.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildRun } from './results.mjs'

export function reparse(outDir, now = new Date()) {
  const file = path.join(outDir, 'results.json')
  const old = JSON.parse(readFileSync(file, 'utf8'))
  if (old.dry) throw new Error('a dry run has no session logs to reparse: run it again with bed.mjs dry')
  const modName = old.specDoc?.mod?.name ?? null
  const runs = old.runs.map((run) => {
    const base = path.join(outDir, 'logs', `${run.scenario}-${run.arm}`)
    if (!existsSync(`${base}.jsonl`)) throw new Error(`no stream log for ${run.scenario}/${run.arm}: ${base}.jsonl`)
    const read = (ext) => (existsSync(base + ext) ? readFileSync(base + ext, 'utf8') : '')
    return buildRun({
      scenario: run.scenario,
      arm: run.arm,
      modName,
      streamText: read('.jsonl'),
      debugText: read('.debug'),
      exitCode: run.exitCode,
      feed: run.feed,
      residue: run.residue,
    })
  })
  const kept = path.join(outDir, `results.before-reparse-${now.toISOString().replace(/[:.]/g, '-')}.json`)
  renameSync(file, kept)
  const record = { ...old, runs, reparsed: now.toISOString() }
  writeFileSync(file, JSON.stringify(record, null, 1))
  return { record, kept }
}
