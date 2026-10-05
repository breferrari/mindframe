// A stand-in for `claude -p` in stream-json mode, so the runner is tested end
// to end with no model, no login and no cost. It answers each user message
// in the event order Claude Code 2.1.289 uses, and writes debug lines in its
// format. FAKE_CLAUDE controls misbehaviour:
//   no-mod-load   --plugin-dir is given but the mod never loads
//   exit-early    exits after the first turn
//   echo-file=<p> answers with the content of bed file <p>
//   slow          takes 300 ms per turn and answers FOLDED if the next
//                 prompt arrived before this turn's result
//   qmd-good      writes a qmd store and config where INDEX_PATH and
//                 QMD_CONFIG_DIR say, as qmd itself does
//   qmd-leak      writes them into the XDG qmd folders, named after the
//                 bed, ignoring both (as a hard-coded config path would)
//   qmd-touch     changes an existing store that isn't the bed's
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const debugFile = flag('--debug-file')
const pluginDir = flag('--plugin-dir')
const mode = process.env.FAKE_CLAUDE ?? ''
const modLoads = pluginDir !== null && mode !== 'no-mod-load'
const sid = '00000000-0000-0000-0000-000000000000'
let n = 0
const uuid = () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`
const emit = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid, uuid: uuid() }) + '\n')
const debug = (line) => debugFile && appendFileSync(debugFile, `${new Date().toISOString()} [DEBUG] ${line}\n`)

function hook(event, name, output) {
  const id = uuid()
  emit({ type: 'system', subtype: 'hook_started', hook_id: id, hook_name: name, hook_event: event })
  emit({ type: 'system', subtype: 'hook_response', hook_id: id, hook_name: name, hook_event: event, output, stdout: output, stderr: '', exit_code: 0, outcome: 'success' })
  debug(JSON.stringify(`Hook ${name} (${event}) success:\n${output}`))
}

debug('MDM settings load completed in 1ms')
if (modLoads) {
  debug('plugin.register: fake-mod (user, fake-mod@inline), judged by core alone: admitted')
  debug('hooks module fake-mod@inline loaded (worker, environment 1, tier user); events: classic.SessionStart,classic.Stop')
  debug('hooks module fake-mod@inline classic.SessionStart settled in 12.5ms (worker hop, next() included)')
}
hook('SessionStart', 'SessionStart:startup', modLoads ? '' : 'session context')

const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const bedName = path.basename(process.cwd())
if (mode === 'qmd-good') {
  put(process.env.INDEX_PATH, 'store')
  put(path.join(process.env.QMD_CONFIG_DIR, `${bedName}.yml`), 'config')
} else if (mode === 'qmd-leak') {
  put(path.join(process.env.XDG_CACHE_HOME, 'qmd', `${bedName}.sqlite`), 'store')
  put(path.join(process.env.XDG_CONFIG_HOME, 'qmd', `${bedName}.yml`), 'config')
} else if (mode === 'qmd-touch') {
  appendFileSync(path.join(process.env.XDG_CACHE_HOME, 'qmd', 'someone-else.sqlite'), 'more')
}

const plugins = [{ name: 'builtin-a', path: 'builtin', source: 'builtin-a@builtin' }]
if (modLoads) plugins.unshift({ name: 'fake-mod', path: 'mod', source: 'fake-mod@inline', version: '0.0.0' })

let turn = 0
let busy = false
let folded = false
const queue = []
let wake = null
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  if (busy || queue.length) folded = true
  queue.push(line)
  wake?.()
})
let closed = false
rl.on('close', () => {
  closed = true
  wake?.()
})
while (true) {
  if (!queue.length) {
    if (closed) break
    await new Promise((r) => (wake = r))
    wake = null
    continue
  }
  busy = true
  const msg = JSON.parse(queue.shift())
  const text = msg.message.content
  turn++
  hook('UserPromptSubmit', 'UserPromptSubmit', '')
  emit({ type: 'system', subtype: 'init', cwd: '.', model: 'fake-model', claude_code_version: '2.1.289', plugins, plugin_warnings: [] })
  emit({ type: 'user', message: { role: 'user', content: text }, isReplay: true })
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 300))
  const echo = mode === 'echo-tools' ? `tools: ${JSON.stringify(flag('--tools'))}` : mode === 'echo-disallowed' ? `disallowed: ${flag('--disallowedTools') ?? 'none'}` : mode.startsWith('echo-file=') ? readFileSync(mode.slice('echo-file='.length), 'utf8') : folded ? 'FOLDED' : `echo: ${text}`
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: echo }] } })
  hook('Stop', 'Stop', '{}')
  if (modLoads) debug('hooks module fake-mod@inline classic.Stop settled in 3.0ms (worker hop, next() included)')
  emit({ type: 'result', subtype: 'success', is_error: false, result: echo, total_cost_usd: 0, duration_ms: 1, result_index: turn - 1 })
  busy = false
  if (mode === 'exit-early') process.exit(0)
}
