#!/usr/bin/env node
// The test bed's command line. See testbed/README.md.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildBed } from '../lib/bed.mjs'
import { EXIT, grade, renderMarkdown } from '../lib/grade.mjs'
import * as judge from '../lib/judge.mjs'
import { compare } from '../lib/compare.mjs'
import { dryRun } from '../lib/dry.mjs'
import { summarize } from '../lib/results.mjs'
import { defaultOut, runSpec } from '../lib/run.mjs'
import { ARMS, loadSpec } from '../lib/spec.mjs'

const USAGE = `usage:
  bed.mjs run   --vault <dir> --spec <file> [--arm settings|mod] [--scenario <id>]... [--out <dir>] [--claude <bin> [--claude-arg <arg>]...]
  bed.mjs grade <results.json>
  bed.mjs judge prepare <results.json>
  bed.mjs judge apply   <results.json> <verdicts.json>
  bed.mjs dry   --vault <dir> --spec <file> [--scenario <id>]... [--out <dir>] [--deliver]
  bed.mjs compare <label>=<results.json> <label>=<results.json>...
  bed.mjs show  <results.json>
  bed.mjs build --vault <dir> --spec <file> --bed <dir>`

function fail(msg) {
  console.error(msg)
  console.error(USAGE)
  process.exit(2)
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const beside = (results, name) => path.join(path.dirname(results), name)

// Grades a results.json in place: grades.json and results.md beside it,
// with the blind grader's verdicts when judge.json is there.
function gradeFile(results) {
  const record = readJson(results)
  const verdictsFile = beside(results, 'judge.json')
  const verdicts = existsSync(verdictsFile) ? readJson(verdictsFile) : {}
  const graded = grade(record, record.specDoc, verdicts)
  writeFileSync(beside(results, 'grades.json'), JSON.stringify(graded, null, 1))
  const md = renderMarkdown(record, graded)
  writeFileSync(beside(results, 'results.md'), md)
  console.log(md)
  return graded
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
    deliver: { type: 'boolean', default: false },
    'claude-arg': { type: 'string', multiple: true },
  },
})

if (command === 'show') {
  if (!positionals[0]) fail('show needs a results.json')
  for (const run of readJson(positionals[0]).runs) console.log(summarize(run))
} else if (command === 'dry') {
  if (!values.vault || !values.spec) fail('dry needs --vault and --spec')
  const spec = loadSpec(values.spec)
  const out = values.out ? path.resolve(values.out) : defaultOut(`${spec.name}-dry`)
  console.log(`output: ${out}`)
  const record = dryRun({ spec, vault: path.resolve(values.vault), out, only: values.scenario ?? null, deliver: values.deliver })
  for (const run of record.runs) console.log(summarize(run))
  process.exitCode = EXIT[gradeFile(path.join(out, 'results.json')).outcome]
} else if (command === 'compare') {
  const labelled = positionals.map((p) => {
    const at = p.indexOf('=')
    if (at <= 0) fail(`compare takes <label>=<results.json>, got ${p}`)
    return { label: p.slice(0, at), record: readJson(p.slice(at + 1)) }
  })
  if (labelled.length < 2) fail('compare needs two or more labelled results')
  console.log(compare(labelled))
} else if (command === 'grade') {
  if (!positionals[0]) fail('grade needs a results.json')
  process.exitCode = EXIT[gradeFile(positionals[0]).outcome]
} else if (command === 'judge') {
  const [sub, results, verdictsFile] = positionals
  if (!results) fail('judge needs prepare or apply, and a results.json')
  if (sub === 'prepare') {
    const record = readJson(results)
    const { blind, key, prompt } = judge.prepare(record, record.specDoc)
    if (blind.length === 0) {
      console.log('no judged expectations in these runs')
    } else {
      writeFileSync(beside(results, 'judge-key.json'), JSON.stringify(key, null, 1))
      writeFileSync(beside(results, 'judge-prompt.md'), prompt)
      console.log(`${blind.length} item(s). Give ${beside(results, 'judge-prompt.md')} to one tool-less model call,`)
      console.log(`save its JSON array, then: bed.mjs judge apply ${results} <verdicts.json>`)
    }
  } else if (sub === 'apply') {
    if (!verdictsFile) fail('judge apply needs a verdicts.json')
    const verdicts = judge.apply(readJson(beside(results, 'judge-key.json')), readJson(verdictsFile))
    writeFileSync(beside(results, 'judge.json'), JSON.stringify(verdicts, null, 1))
    process.exitCode = EXIT[gradeFile(results).outcome]
  } else {
    fail(`unknown judge command: ${sub}`)
  }
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
    await runSpec({
      spec,
      vault,
      out,
      arms: values.arm ? [values.arm] : null,
      only: values.scenario ?? null,
      cmd: [values.claude, ...(values['claude-arg'] ?? [])],
      onRun: (run) => console.log(summarize(run)),
    })
    process.exitCode = EXIT[gradeFile(path.join(out, 'results.json')).outcome]
  }
} else {
  fail(command ? `unknown command: ${command}` : 'no command')
}
