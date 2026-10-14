import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { leftovers, listProcesses, listingCommand, parseProcessList, runFolders } from '../lib/procs.mjs'
import { tmp } from './_helpers.mjs'

test('the listing is PowerShell on Windows, filtered to processes with a command line, and ps -ww elsewhere', () => {
  const win = listingCommand('win32')
  assert.equal(win.cmd, 'powershell')
  assert.match(win.args.at(-1), /Get-CimInstance Win32_Process/)
  assert.match(win.args.at(-1), /ProcessId -ne \$PID/, 'not the listing itself')
  assert.deepEqual(listingCommand('linux'), { cmd: 'ps', args: ['-ax', '-ww', '-o', 'pid=,args='] })
  assert.deepEqual(listingCommand('darwin').cmd, 'ps')
})

test('a listing parses to pid and command line, blank and malformed lines skipped', () => {
  assert.deepEqual(parseProcessList('  12 node /bed/a.ts\r\n\nnot a line\n345\tC:\\bed\\b.ts --x \n'), [
    { pid: 12, cmd: 'node /bed/a.ts' },
    { pid: 345, cmd: 'C:\\bed\\b.ts --x' },
  ])
})

test('a listing that fails says why, never reads as no processes', () => {
  assert.deepEqual(listProcesses(() => ({ error: new Error('ENOENT') }), 'linux'), { failed: 'ps: ENOENT' })
  assert.deepEqual(listProcesses(() => ({ signal: 'SIGTERM' }), 'linux'), { failed: 'ps killed by SIGTERM' })
  assert.deepEqual(listProcesses(() => ({ status: 1, stdout: '' }), 'linux'), { failed: 'ps exit 1' })
  assert.deepEqual(listProcesses(() => ({ status: 0, stdout: `1 init\n${process.pid} me\n` }), 'linux'), { procs: [{ pid: 1, cmd: 'init' }] }, 'not this process')
})

test('a leftover is new since the run began, and the run started it: its command line names one of the run folders', () => {
  const before = { procs: [{ pid: 1, cmd: 'node /out/bed/old.ts' }] }
  const after = {
    procs: [
      { pid: 1, cmd: 'node /out/bed/old.ts' },
      { pid: 2, cmd: 'node /out/bed/.claude/scripts/extensions/qmd/qmd-refresh-run.ts --vault=/out/bed' },
      { pid: 4, cmd: 'node /elsewhere/server.js' },
      { pid: 5, cmd: 'sleep 60 /out/x' },
      { pid: 6, cmd: 'node /repo/core/scripts/extensions/qmd/qmd-refresh-run.ts --vault=/tmp/other' },
      { pid: 7, cmd: 'node --experimental-strip-types .scripts/qmd-bootstrap.ts' },
    ],
  }
  const got = leftovers(before, after, ['/out/bed', '/out/x'], 'linux')
  assert.deepEqual(
    got.map((l) => l.file),
    ['2 node /out/bed/.claude/scripts/extensions/qmd/qmd-refresh-run.ts --vault=/out/bed', '5 sleep 60 /out/x'],
    "a worker another test started from its own folder is not ours, and nor is one that names no folder",
  )
  assert.deepEqual(got.map((l) => [l.kind, l.pid, l.change]), [['process', 2, 'left running'], ['process', 5, 'left running']])
  assert.deepEqual(leftovers(before, before, ['/out/bed'], 'linux'), [], 'nothing new, nothing left')
})

test('on Windows a folder matches in any case and with either slash; elsewhere case counts', () => {
  const after = { procs: [{ pid: 2, cmd: 'node c:/users/runneradmin/OUT/bed/w.js' }] }
  assert.deepEqual(leftovers({ procs: [] }, after, ['C:\\Users\\runneradmin\\out'], 'win32').map((l) => l.pid), [2])
  assert.deepEqual(leftovers({ procs: [] }, { procs: [{ pid: 2, cmd: 'node /tmp/OUT/w.js' }] }, ['/tmp/out'], 'linux'), [])
})

test("a listing that failed is a leak: the check didn't run, so the run can't pass", () => {
  const ok = { procs: [] }
  assert.deepEqual(leftovers({ failed: 'ps exit 1' }, ok, ['/b']), [{ kind: 'process', file: 'ps exit 1', change: 'not checked' }])
  assert.deepEqual(leftovers(ok, { failed: 'ps: ENOENT' }, ['/b']), [{ kind: 'process', file: 'ps: ENOENT', change: 'not checked' }])
})

test("the run's folders are its output as given and as resolved, so a worker naming either is seen", (t) => {
  const real = path.join(tmp(t), 'real')
  mkdirSync(real)
  const link = path.join(path.dirname(real), 'link')
  // A junction needs no privilege on Windows; elsewhere the type is ignored.
  symlinkSync(real, link, 'junction')
  const folders = runFolders(link)
  assert.equal(folders[0], link)
  assert.ok(folders.includes(realpathSync.native(link)), JSON.stringify(folders))
  const after = { procs: [{ pid: 9, cmd: `node ${path.join(realpathSync.native(link), 'w.js')}` }] }
  assert.deepEqual(leftovers({ procs: [] }, after, folders).map((l) => l.pid), [9])
  assert.deepEqual(runFolders(real), [...new Set([real, realpathSync(real), realpathSync.native(real)])], 'one entry per distinct form')
})
