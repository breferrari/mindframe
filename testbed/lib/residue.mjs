// What a bed session must not leave on the machine. A bed vault with QMD
// writes an index store and a collection config named after the bed folder
// into the user's own qmd folders. The runner points both at the run's
// output folder (qmdEnv), and snapshots the user's folders before and after
// each session, so anything that still lands there is reported as a leak.
// Nothing here deletes: a leak is for a person to look at.
//
// qmd's own rules (@tobilu/qmd 2.5.3):
//   store:  INDEX_PATH, else ($XDG_CACHE_HOME or ~/.cache)/qmd/<index>.sqlite
//   config: QMD_CONFIG_DIR, else ($XDG_CONFIG_HOME or ~/.config)/qmd/<index>.yml
// The embedding models live in <cache>/qmd/models and stay shared: they are
// large, and re-downloading them per bed would be the wrong fix.
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = (env) => env.HOME || env.USERPROFILE || os.homedir()

// The user's qmd folders, as qmd resolves them for this environment.
export function userQmdDirs(env) {
  return {
    cache: path.join(env.XDG_CACHE_HOME || path.join(home(env), '.cache'), 'qmd'),
    config: path.join(env.XDG_CONFIG_HOME || path.join(home(env), '.config'), 'qmd'),
  }
}

// The environment that sends a session's qmd store and config into the run.
export function qmdEnv(runDir) {
  return {
    INDEX_PATH: path.join(runDir, 'qmd', 'index.sqlite'),
    QMD_CONFIG_DIR: path.join(runDir, 'qmd', 'config'),
  }
}

const SHARED = new Set(['models'])

// Top-level entries of each folder: name -> size and mtime. A missing
// folder is an empty snapshot.
export function snapshot(dirs) {
  const out = {}
  for (const [kind, dir] of Object.entries(dirs)) {
    const entries = {}
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (SHARED.has(name)) continue
        try {
          const s = statSync(path.join(dir, name))
          entries[name] = { size: s.size, mtimeMs: s.mtimeMs }
        } catch {
          // gone between the listing and the stat: someone else's file
        }
      }
    }
    out[kind] = { dir, entries }
  }
  return out
}

// A leak is a new entry, or a changed entry named after the bed (a store
// from an earlier run of the same bed name, written again). Other changed
// entries are only noted: the user's own sessions write to their stores
// while a bed runs.
export function diff(before, after, bedName) {
  const leaks = []
  const touched = []
  for (const kind of Object.keys(after)) {
    const was = before[kind]?.entries ?? {}
    for (const [name, now] of Object.entries(after[kind].entries)) {
      const file = path.join(after[kind].dir, name)
      if (!(name in was)) leaks.push({ kind, file, change: 'created' })
      else if (was[name].size !== now.size || was[name].mtimeMs !== now.mtimeMs) {
        if (name.startsWith(bedName)) leaks.push({ kind, file, change: 'changed' })
        else touched.push({ kind, file })
      }
    }
  }
  return { leaks, touched }
}
