// Reads what the stream does not carry from a session's debug log: which
// hooks modules (mods) loaded, and how long each module took per event.
// Line formats as written by Claude Code 2.1.289:
//
//   <iso> [DEBUG] plugin.register: <name> (<scope>, <id>), judged by core alone: admitted
//   <iso> [DEBUG] hooks module <id> loaded (<kind>, environment <n>, tier <t>); events: a,b,c
//   <iso> [DEBUG] hooks module <id> <event> settled in <ms>ms (<hop>, next() included)
//   <iso> [DEBUG] "Hook <name> (<event>) success:\n<output>"
//
// Only "success" has been seen for settings hooks; any other word in that
// place is recorded as the status, so a failure shows up rather than
// vanishing.

const PREFIX = /^(\S+) \[(\w+)\] /
const REGISTER = /^plugin\.register: (\S+) \(([^,]+), ([^)]+)\), judged by (.+?): (\w+)/
const LOADED = /^hooks module (\S+) loaded \(([^)]*)\); events: (.*)$/
const SETTLED = /^hooks module (\S+) (\S+) settled in ([\d.]+)ms/
const HOOK = /^"Hook (.+?) \((\w+)\) (\w+):/
const MODULE_PROBLEM = /^hooks module (\S+) .*\b(failed|error|threw|refused|timed out|skipped)\b/i

export function parseDebug(text) {
  const out = { registered: [], loaded: [], settled: [], hooks: [], moduleProblems: [] }
  for (const raw of text.split('\n')) {
    const p = PREFIX.exec(raw)
    if (!p) continue
    const at = p[1]
    const line = raw.slice(p[0].length)
    let m
    if ((m = REGISTER.exec(line))) out.registered.push({ at, name: m[1], scope: m[2], id: m[3], verdict: m[5] })
    else if ((m = LOADED.exec(line))) out.loaded.push({ at, id: m[1], how: m[2], events: m[3].split(',').filter(Boolean) })
    else if ((m = SETTLED.exec(line))) out.settled.push({ at, id: m[1], event: m[2], ms: Number(m[3]) })
    else if ((m = HOOK.exec(line))) out.hooks.push({ at, name: m[1], event: m[2], status: m[3] })
    else if ((m = MODULE_PROBLEM.exec(line))) out.moduleProblems.push({ at, id: m[1], line })
  }
  return out
}
