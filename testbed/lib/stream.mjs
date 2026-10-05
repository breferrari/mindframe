// Reads a session's stream-json output into turns. Formats as written by
// Claude Code 2.1.289 with --include-hook-events and --replay-user-messages:
//
// - settings hooks: `system/hook_started` then `system/hook_response`
//   ({ hook_name, hook_event, exit_code, outcome, output, stdout, stderr });
// - a turn's UserPromptSubmit hook events come before its replayed `user`
//   message, and a `system/init` repeats at every turn;
// - a `result` closes each turn; some events land after it (a mod's
//   turn.complete line arrives as `system/informational` after the result),
//   so they stay with the turn that just closed;
// - `system/informational` is what the user sees (a Stop systemMessage
//   shows as "Stop says: ...").

export function parseJsonl(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      out.push({ type: 'unparsed', line })
    }
  }
  return out
}

const newTurn = (index) => ({ index, prompt: null, answer: '', tools: [], toolCalls: [], hooks: [], informational: [], result: null })

// The parts of a tool call's input that say what it touched: a file, a
// path, a search pattern, a command. Long values are cut; the rest is
// dropped, so a transcript's file contents never land in results.json.
const TOOL_TARGETS = ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'url']
function toolTarget(input) {
  const out = {}
  for (const k of TOOL_TARGETS) if (typeof input?.[k] === 'string') out[k] = input[k].slice(0, 300)
  return out
}

function hookEntry(m) {
  return {
    id: m.hook_id,
    name: m.hook_name,
    event: m.hook_event,
    status: 'started',
    exitCode: null,
    outcome: null,
    output: '',
    stderr: '',
  }
}

// A turn starts at its first UserPromptSubmit hook, its replayed prompt, or
// its init, whichever comes first after the previous result.
//
// A /compact turn is a local command and looks different (2.1.289): after
// the previous result come `system/status` "compacting", the SessionStart
// hooks with source compact, `init`, `system/compact_boundary`, the summary
// as a user message that is not a replay, and then the replayed
// `<local-command-stdout>`. There is no UserPromptSubmit and no Stop. So
// "compacting", or a compact, clear or resume SessionStart arriving with no
// turn open, starts the next turn too; otherwise those hooks would be kept
// with the turn before.
function startsTurn(m) {
  return (
    (m.type === 'system' && m.subtype === 'hook_started' && m.hook_event === 'UserPromptSubmit') ||
    (m.type === 'system' && m.subtype === 'hook_started' && m.hook_event === 'SessionStart' && /:(compact|clear|resume)$/.test(m.hook_name ?? '')) ||
    (m.type === 'system' && m.subtype === 'status' && m.status === 'compacting') ||
    (m.type === 'user' && m.isReplay === true) ||
    (m.type === 'system' && m.subtype === 'init')
  )
}

// PreCompact never reaches the stream as a hook event; the /compact command's
// own output names each one: "Compacted PreCompact [<command>] completed
// successfully". The command holds brackets of its own (shell tests), so the
// match runs to the last "] completed" or "] failed" before the next one.
const PRE_COMPACT = /PreCompact \[([\s\S]*?)\] (completed successfully|failed[^\n<]*?)(?=, PreCompact \[|<\/local-command-stdout>|$)/g

export function preCompactHooks(stdout) {
  const out = []
  for (const m of String(stdout).matchAll(PRE_COMPACT)) {
    const ok = m[2] === 'completed successfully'
    out.push({ id: null, name: 'PreCompact', event: 'PreCompact', status: 'responded', exitCode: ok ? 0 : 1, outcome: ok ? 'success' : 'error', output: '', stderr: ok ? '' : m[2], from: 'local-command-stdout' })
  }
  return out
}

export function parseStream(text) {
  const msgs = parseJsonl(text)
  const session = { version: null, model: null, plugins: [], pluginWarnings: [], preamble: [], unparsed: 0 }
  const turns = []
  let cur = null // the open turn
  let closed = null // the last closed turn, which keeps late events
  const byId = new Map()

  const target = () => cur ?? closed
  for (const m of msgs) {
    if (m.type === 'unparsed') {
      session.unparsed++
      continue
    }
    if (!cur && startsTurn(m)) {
      cur = newTurn(turns.length + 1)
      turns.push(cur)
    }
    if (m.type === 'system' && m.subtype === 'init') {
      session.version ??= m.claude_code_version ?? null
      session.model ??= m.model ?? null
      if (session.plugins.length === 0) session.plugins = m.plugins ?? []
      if (session.pluginWarnings.length === 0) session.pluginWarnings = m.plugin_warnings ?? []
    } else if (m.type === 'system' && m.subtype === 'hook_started') {
      const h = hookEntry(m)
      byId.set(m.hook_id, h)
      ;(target()?.hooks ?? session.preamble).push(h)
    } else if (m.type === 'system' && m.subtype === 'hook_response') {
      let h = byId.get(m.hook_id)
      if (!h) {
        h = hookEntry(m)
        ;(target()?.hooks ?? session.preamble).push(h)
      }
      Object.assign(h, {
        status: 'responded',
        exitCode: m.exit_code ?? null,
        outcome: m.outcome ?? null,
        output: m.output ?? m.stdout ?? '',
        stderr: m.stderr ?? '',
      })
    } else if (m.type === 'system' && m.subtype === 'informational') {
      target()?.informational.push(m.content)
    } else if (m.type === 'user' && m.isReplay === true) {
      const c = m.message?.content
      cur.prompt = typeof c === 'string' ? c : JSON.stringify(c)
      if (cur.prompt.includes('<local-command-stdout>')) cur.hooks.push(...preCompactHooks(cur.prompt))
    } else if (m.type === 'assistant') {
      const t = target()
      if (!t) continue
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text') t.answer += (t.answer ? '\n' : '') + c.text
        if (c.type === 'tool_use') {
          t.tools.push(c.name)
          t.toolCalls.push({ name: c.name, input: toolTarget(c.input) })
        }
      }
    } else if (m.type === 'result') {
      if (!cur) continue
      cur.result = { subtype: m.subtype, isError: m.is_error === true, costUsd: m.total_cost_usd ?? null, durationMs: m.duration_ms ?? null }
      closed = cur
      cur = null
    }
  }
  return { session, turns }
}
