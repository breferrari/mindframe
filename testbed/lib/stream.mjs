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

const newTurn = (index) => ({ index, prompt: null, answer: '', tools: [], hooks: [], informational: [], result: null })

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
function startsTurn(m) {
  return (
    (m.type === 'system' && m.subtype === 'hook_started' && m.hook_event === 'UserPromptSubmit') ||
    (m.type === 'user' && m.isReplay === true) ||
    (m.type === 'system' && m.subtype === 'init')
  )
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
    } else if (m.type === 'assistant') {
      const t = target()
      if (!t) continue
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text') t.answer += (t.answer ? '\n' : '') + c.text
        if (c.type === 'tool_use') t.tools.push(c.name)
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
