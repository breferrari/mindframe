// Runs every scenario of a spec on each of its arms, in a fresh bed per
// session, and writes results.json. Raw output goes to a folder outside the
// repo by default: debug logs and transcripts carry local paths and session
// ids. Each session's qmd store and config go there too, and the user's
// qmd folders are compared before and after it (residue.mjs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildBed, vaultCommit } from './bed.mjs'
import { bedEnv } from './dry.mjs'
import { diff, snapshot, userQmdDirs } from './residue.mjs'
import { buildRun } from './results.mjs'
import { runSession } from './session.mjs'

export function defaultOut(specName, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return path.join(os.tmpdir(), 'mindframe-testbed', `${specName}-${stamp}`)
}

const readOr = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')

export async function runSpec({ spec, vault, out, arms, only, cmd, onRun = () => {} }) {
  if (existsSync(out)) throw new Error(`output folder exists, pick a new one: ${out}`)
  mkdirSync(out, { recursive: true })
  const record = {
    spec: spec.name,
    // The validated spec travels with the results, so grading needs nothing else.
    specDoc: spec,
    vault: { commit: vaultCommit(vault) },
    started: new Date().toISOString(),
    runs: [],
  }
  for (const s of spec.scenarios) {
    if (only && !only.includes(s.id)) continue
    for (const arm of s.arms) {
      if (arms && !arms.includes(arm)) continue
      const name = `${s.id}-${arm}`
      const bed = path.join(out, 'beds', name)
      buildBed({ vault, bed, spec, files: s.files })
      // The same builder a dry run uses; runSession adds the user's environment.
      const env = bedEnv({ base: {}, stateDir: path.join(out, 'state', name), spec, scenario: s })
      const session = { ...spec.session, env, allowedTools: s.allowedTools ?? spec.session.allowedTools, disallowedTools: s.disallowedTools ?? spec.session.disallowedTools, tools: s.tools ?? spec.session.tools }
      const dirs = userQmdDirs({ ...process.env, ...env })
      const before = snapshot(dirs)
      const r = await runSession({ cmd, arm, bed, mod: spec.mod, session, turns: s.turns, logDir: path.join(out, 'logs'), name })
      const run = buildRun({
        scenario: s.id,
        arm,
        modName: spec.mod?.name ?? null,
        streamText: readOr(r.files.stream),
        debugText: readOr(r.files.debug),
        exitCode: r.code,
        feed: r.feed,
        residue: diff(before, snapshot(dirs), name),
      })
      record.runs.push(run)
      onRun(run)
    }
  }
  record.finished = new Date().toISOString()
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(record, null, 1))
  return record
}
