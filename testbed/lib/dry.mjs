// A dry run: a spec's scenarios replayed with no model and no Claude Code.
// Each scenario gets a fresh bed, and the vault's own hook scripts run
// directly, in the order a session would run them:
//   SessionStart (startup), then per turn UserPromptSubmit, PreCompact and
//   SessionStart (compact) for a "/compact" turn, the turn's file write as
//   a Write plus PostToolUse when the turn asks to create one, and Stop.
// The settings arm only: the mod needs Claude Code.
//
// It answers the log layer before a live session spends anything: what the
// hooks print, in order, against the expectations. The model layer can't be
// checked, so answers, what the user is shown, judged rows and mod events
// are left out of the grade, and measures that read an answer or a tool
// call record nothing.
//
// Every spawn gets the same environment a live session would (qmdEnv, the
// spec's and the scenario's env), and the user's qmd folders are compared
// before and after each scenario, exactly as in a live run.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildBed, vaultCommit } from './bed.mjs'
import { diff, qmdEnv, snapshot, userQmdDirs } from './residue.mjs'
import { hookRow } from './results.mjs'

// The vault's entry points, by event. Every vault on the om_mod contract
// uses these names (the mod runs two of them by path).
export const DRY_SCRIPTS = {
  SessionStart: 'session-start.ts',
  UserPromptSubmit: 'classify-message.ts',
  PostToolUse: 'validate-write.ts',
  PreCompact: 'pre-compact.ts',
  Stop: 'stop-checklist.ts',
}

// Kinds a dry run can't check: they need a model or Claude Code itself.
export const DRY_SKIPPED = new Set(['answer', 'shown', 'judge', 'modEvent'])

// The environment a bed's spawns get, dry or live: the user's environment,
// then the run's qmd redirect, then the spec's and the scenario's own.
export function bedEnv({ base = process.env, stateDir, spec, scenario }) {
  return { ...base, ...qmdEnv(stateDir), ...spec.session.env, ...scenario.env }
}

// The file a turn asks to create, as "... create 'path' ...", if any.
const CREATE = /create '([^']+)'/

// `deliver` also runs SessionStart the way the mod does, with
// `om_mod: "deliver"`, and keeps its output as the run's `deliver`: what the
// mod would hand the model as its instruction file. Measures read it as the
// `deliver` source. It is outside the settings hooks, so no hook expectation
// sees it.
export function dryRun({ spec, vault, out, only, deliver = false, runner = execFileSync }) {
  if (existsSync(out)) throw new Error(`output folder exists, pick a new one: ${out}`)
  mkdirSync(out, { recursive: true })
  const record = { spec: spec.name, specDoc: spec, dry: true, vault: { commit: vaultCommit(vault) }, started: new Date().toISOString(), runs: [] }
  for (const s of spec.scenarios) {
    if (only && !only.includes(s.id)) continue
    if (!s.arms.includes('settings')) continue
    const name = `${s.id}-dry`
    const bed = path.join(out, 'beds', name)
    buildBed({ vault, bed, spec, files: s.files })
    const env = { ...bedEnv({ stateDir: path.join(out, 'state', name), spec, scenario: s }), CLAUDE_PROJECT_DIR: bed }
    const dirs = userQmdDirs(env)
    const before = snapshot(dirs)

    const hook = (event, input, hookName = event) => {
      const script = path.join(bed, '.claude', 'scripts', DRY_SCRIPTS[event])
      let output = ''
      let stderr = ''
      let exitCode = 0
      try {
        output = runner(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', script], {
          input: JSON.stringify({ hook_event_name: event, session_id: name, ...input }),
          cwd: bed,
          env,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        exitCode = err.status ?? 1
        output = err.stdout ?? ''
        stderr = String(err.stderr ?? '').slice(0, 2000)
      }
      // The same row a live run records, outputBytes included.
      return hookRow({ event, name: hookName, status: 'responded', exitCode, outcome: exitCode === 0 ? 'success' : 'error', output, stderr })
    }

    const preamble = [hook('SessionStart', { source: 'startup' }, 'SessionStart:startup')]
    const delivered = deliver ? hook('SessionStart', { source: 'startup', om_mod: 'deliver' }, 'SessionStart:deliver') : null
    const turns = s.turns.map((t, i) => {
      for (const a of t.before) applyBefore(bed, a)
      const hooks = [hook('UserPromptSubmit', { prompt: t.text })]
      const tools = []
      const toolCalls = []
      if (t.text.trim() === '/compact') {
        hooks.push(hook('PreCompact', { trigger: 'manual' }))
        hooks.push(hook('SessionStart', { source: 'compact' }, 'SessionStart:compact'))
      }
      const create = CREATE.exec(t.text)
      if (create) {
        const file = path.join(bed, ...create[1].split('/'))
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, 'dry\n')
        tools.push('Write')
        toolCalls.push({ name: 'Write', input: { file_path: file } })
        hooks.push(hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: file } }, 'PostToolUse:Write'))
      }
      hooks.push(hook('Stop', { stop_hook_active: false }))
      return { index: i + 1, prompt: t.text, answer: '', tools, toolCalls, hooks, informational: [], result: null }
    })

    record.runs.push({
      scenario: s.id,
      arm: 'settings',
      dry: true,
      exitCode: 0,
      valid: true,
      armCheck: { ok: true, evidence: { dry: true } },
      claudeVersion: null,
      model: null,
      preamble,
      turns,
      mod: null,
      debugHooks: [],
      feed: [],
      ...(delivered ? { deliver: { exitCode: delivered.exitCode, output: delivered.output } } : {}),
      residue: diff(before, snapshot(dirs), name),
    })
  }
  record.finished = new Date().toISOString()
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(record, null, 1))
  return record
}

function applyBefore(bed, a) {
  const file = path.join(bed, ...(a.append ?? a.write).split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  if ('append' in a) writeFileSync(file, (a.char ?? 'y').repeat(a.bytes), { flag: 'a' })
  else writeFileSync(file, a.content)
}
