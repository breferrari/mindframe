// The processes a run leaves behind (#99): a detached worker a vault's hook
// starts outlives the run, and a qmd worker that writes the user's qmd
// folders after the "after" snapshot would be missed by the residue check.
// The runner lists processes before and after each scenario, and records
// every new one still alive that the bed started as a leak. It never kills
// one: a leak is for a person to look at.
//
// After obsidian-mind's tests/_proc.ts (its #337, #350): one listing of
// every process with its full command line, -ww on POSIX so a long one is
// never cut before the match.

import { spawnSync } from 'node:child_process'

/** The listing command for `platform`, every process with its command line. */
export function listingCommand(platform = process.platform) {
  if (platform === 'win32') {
    return {
      cmd: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // UTF-8 out, so a non-ASCII path survives the pipe; not this PowerShell
        // itself; each command line on one line, so a continuation line never
        // reads as a pid of its own.
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine -replace '[\\r\\n]+', ' ')\" }",
      ],
    }
  }
  return { cmd: 'ps', args: ['-ax', '-ww', '-o', 'pid=,args='] }
}

/** `{ pid, cmd }` for each `<pid><whitespace><command line>` line. */
export function parseProcessList(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(.*\S)\s*$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }))
}

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true })

/** Every process, or why the listing failed, so a caller never reads a failed listing as none. */
export function listProcesses(runner = run, platform = process.platform) {
  const { cmd, args } = listingCommand(platform)
  const r = runner(cmd, args)
  if (r.error !== undefined) return { failed: `${cmd}: ${r.error.message}` }
  if (r.signal) return { failed: `${cmd} killed by ${r.signal}` }
  if (r.status !== 0 || typeof r.stdout !== 'string') return { failed: `${cmd} exit ${r.status}` }
  return { procs: parseProcessList(r.stdout).filter((p) => p.pid !== process.pid) }
}

// Windows paths match whatever their case and slashes.
const pathForm = (platform) => (platform === 'win32' ? (s) => s.toLowerCase().replaceAll('/', '\\') : (s) => s)

/**
 * The processes `after` holds that `before` didn't, and that the run
 * started: their command line names one of `folders`, as obsidian-mind
 * #338's runner checks. As leaks, in the residue check's shape, with the
 * pid. A listing that failed is a leak too: the check didn't run, so the
 * run can't pass.
 */
export function leftovers(before, after, folders, platform = process.platform) {
  if ('failed' in before || 'failed' in after) {
    return [{ kind: 'process', file: ('failed' in before ? before : after).failed, change: 'not checked' }]
  }
  const had = new Set(before.procs.map((p) => p.pid))
  const form = pathForm(platform)
  const named = (cmd) => folders.some((f) => form(cmd).includes(form(f)))
  return after.procs
    .filter((p) => !had.has(p.pid) && named(p.cmd))
    .map((p) => ({ kind: 'process', pid: p.pid, file: `${p.pid} ${p.cmd}`, change: 'left running' }))
}

/** The residue check's result, with `procs` added to its leaks. */
export const withLeftovers = (residue, procs) => ({ ...residue, leaks: [...residue.leaks, ...procs] })
