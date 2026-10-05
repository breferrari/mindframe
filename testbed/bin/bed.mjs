#!/usr/bin/env node
// The test bed's command line. See testbed/README.md.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildBed } from '../lib/bed.mjs'
import { summarize } from '../lib/results.mjs'
import { defaultOut, runSpec } from '../lib/run.mjs'
import { ARMS, loadSpec } from '../lib/spec.mjs'

const USAGE = `usage:
  bed.mjs run   --vault <dir> --spec <file> [--arm settings|mod] [--scenario <id>]... [--out <dir>] [--claude <bin>]
  bed.mjs build --vault <dir> --spec <file> --bed <dir>
  bed.mjs show  <results.json>`

function fail(msg) {
  console.error(msg)
  console.error(USAGE)
  process.exit(2)
}

const [command, ...rest] = process.argv.slice(2)
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    vault: { type: 'string' },
    spec: { type: 'string' },
    arm: { type: 'string' },
    scenario: { type: 'string', multiple: true },
    out: { type: 'string' },
    bed: { type: 'string' },
    claude: { type: 'string', default: 'claude' },
  },
})

if (command === 'show') {
  if (!positionals[0]) fail('show needs a results.json')
  const record = JSON.parse(readFileSync(positionals[0], 'utf8'))
  for (const run of record.runs) console.log(summarize(run))
} else if (command === 'build' || command === 'run') {
  if (!values.vault || !values.spec) fail(`${command} needs --vault and --spec`)
  const spec = loadSpec(values.spec)
  const vault = path.resolve(values.vault)
  if (command === 'build') {
    if (!values.bed) fail('build needs --bed')
    const { files } = buildBed({ vault, bed: path.resolve(values.bed), spec })
    console.log(`bed built: ${files} files`)
  } else {
    if (values.arm && !ARMS.includes(values.arm)) fail(`--arm must be one of ${ARMS.join(', ')}`)
    const out = values.out ? path.resolve(values.out) : defaultOut(spec.name)
    console.log(`output: ${out}`)
    const record = await runSpec({
      spec,
      vault,
      out,
      arms: values.arm ? [values.arm] : null,
      only: values.scenario ?? null,
      cmd: [values.claude],
      onRun: (run) => console.log(summarize(run)),
    })
    const invalid = record.runs.filter((r) => !r.valid).length
    console.log(`results: ${path.join(out, 'results.json')}${invalid ? ` (${invalid} invalid run(s))` : ''}`)
    process.exitCode = invalid ? 1 : 0
  }
} else {
  fail(command ? `unknown command: ${command}` : 'no command')
}
