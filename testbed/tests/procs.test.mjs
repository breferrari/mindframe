import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leftovers, listProcesses, listingCommand, parseProcessList } from '../lib/procs.mjs'

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

test("a leftover is new since the run began, and the run started it: it names the bed or the output, or is obsidian-mind's relative bootstrap", () => {
  const before = { procs: [{ pid: 1, cmd: 'node /out/bed/old.ts' }] }
  const after = {
    procs: [
      { pid: 1, cmd: 'node /out/bed/old.ts' },
      { pid: 2, cmd: 'node /out/bed/.claude/scripts/extensions/qmd/qmd-refresh-run.ts --vault=/out/bed' },
      { pid: 3, cmd: 'node --experimental-strip-types .scripts/qmd-bootstrap.ts' },
      { pid: 4, cmd: 'node /elsewhere/server.js' },
      { pid: 5, cmd: 'sleep 60 /out/x' },
      { pid: 6, cmd: 'node /repo/core/scripts/extensions/qmd/qmd-refresh-run.ts --vault=/tmp/other' },
      { pid: 7, cmd: '"C:\\node.exe" --experimental-strip-types .scripts\\qmd-bootstrap.ts' },
    ],
  }
  assert.deepEqual(
    leftovers(before, after, ['/out/bed', '/out/x']).map((l) => l.file),
    ['2 node /out/bed/.claude/scripts/extensions/qmd/qmd-refresh-run.ts --vault=/out/bed', '3 node --experimental-strip-types .scripts/qmd-bootstrap.ts', '5 sleep 60 /out/x', '7 "C:\\node.exe" --experimental-strip-types .scripts\\qmd-bootstrap.ts'],
    'a worker another test started from its own folder is not ours',
  )
  assert.ok(leftovers(before, after, ['/out/bed']).every((l) => l.kind === 'process' && l.change === 'left running'))
  assert.deepEqual(leftovers(before, before, ['/out/bed']), [], 'nothing new, nothing left')
})

test("a listing that failed is a leak: the check didn't run, so the run can't pass", () => {
  const ok = { procs: [] }
  assert.deepEqual(leftovers({ failed: 'ps exit 1' }, ok, ['/b']), [{ kind: 'process', file: 'ps exit 1', change: 'not checked' }])
  assert.deepEqual(leftovers(ok, { failed: 'ps: ENOENT' }, ['/b']), [{ kind: 'process', file: 'ps: ENOENT', change: 'not checked' }])
})
