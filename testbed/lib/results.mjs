// Turns a session's stream and debug log into one run record, and checks the
// run tested the arm it claims. A mod-arm session where the mod didn't load,
// or a settings-arm session where it did, is invalid: its hook results
// would describe the other arm.
import { parseDebug } from './debug.mjs'
import { parseStream } from './stream.mjs'

// Evidence comes from two places, and both must agree:
// - the stream's init lists the session's plugins (an inline mod shows as
//   `<name>@inline`);
// - the debug log has a `hooks module <name>@<source> loaded` line.
export function checkArm({ arm, modName, session, debug }) {
  const inInit = session.plugins.some((p) => p.name === modName)
  const loaded = debug.loaded.some((l) => l.id.split('@')[0] === modName)
  const evidence = { initListsMod: inInit, debugLoadedMod: loaded, initSeen: session.version !== null }
  if (!evidence.initSeen) return { ok: false, reason: 'no init event in the stream', evidence }
  if (arm === 'mod') {
    if (inInit && loaded) return { ok: true, evidence }
    return { ok: false, reason: `the mod ${modName} did not load`, evidence }
  }
  if (!modName) return { ok: true, evidence }
  if (inInit || loaded) return { ok: false, reason: `the mod ${modName} loaded on the settings arm`, evidence }
  return { ok: true, evidence }
}

// Per hook, per turn: what ran and how it ended. A hook that started and
// never responded (killed, timed out) keeps status 'started'.
export const hookRow = (h) => ({
  event: h.event,
  name: h.name,
  status: h.status,
  exitCode: h.exitCode,
  outcome: h.outcome,
  outputBytes: Buffer.byteLength(h.output ?? ''),
  output: h.output,
  stderr: h.stderr,
})

export function buildRun({ scenario, arm, modName, streamText, debugText, exitCode, feed, residue = { leaks: [], touched: [] } }) {
  const { session, turns } = parseStream(streamText)
  const debug = parseDebug(debugText)
  const armCheck = checkArm({ arm, modName, session, debug })
  // total_cost_usd on each result is the session's running total, so the
  // session cost is the last one reported.
  const costs = turns.map((t) => t.result?.costUsd).filter((c) => typeof c === 'number')
  const costUsd = costs.length ? costs[costs.length - 1] : null
  const modTimings = modName ? debug.settled.filter((s) => s.id.split('@')[0] === modName).map(({ event, ms }) => ({ event, ms })) : []
  return {
    scenario,
    arm,
    exitCode,
    valid: armCheck.ok,
    armCheck,
    claudeVersion: session.version,
    model: session.model,
    costUsd,
    preamble: session.preamble.map(hookRow),
    turns: turns.map((t) => ({
      index: t.index,
      prompt: t.prompt,
      answer: t.answer,
      tools: t.tools,
      toolCalls: t.toolCalls,
      hooks: t.hooks.map(hookRow),
      informational: t.informational,
      result: t.result,
    })),
    mod: modName ? { name: modName, timings: modTimings, problems: debug.moduleProblems.filter((p) => p.id.split('@')[0] === modName) } : null,
    debugHooks: debug.hooks,
    feed,
    // Files the session left in the user's qmd folders; a leak fails the grade.
    residue,
  }
}

// One line per hook per turn, for reading a run at a glance.
export function summarize(run) {
  const lines = [`== ${run.scenario} [${run.arm}] ${run.valid ? 'valid' : 'INVALID: ' + run.armCheck.reason} (claude ${run.claudeVersion ?? '?'}, exit ${run.exitCode}${typeof run.costUsd === 'number' ? `, $${run.costUsd.toFixed(2)}` : ''})`]
  const hook = (h) => `${h.event}${h.name !== h.event ? ` (${h.name})` : ''}: ${h.status === 'responded' ? `${h.outcome ?? '?'} exit=${h.exitCode} ${h.outputBytes}B` : 'NO RESPONSE'}`
  for (const h of run.preamble) lines.push(`  pre   ${hook(h)}`)
  for (const t of run.turns) {
    lines.push(`  T${t.index} > ${(t.prompt ?? '').slice(0, 80)}`)
    for (const h of t.hooks) lines.push(`        ${hook(h)}`)
    for (const i of t.informational) lines.push(`        shown: ${String(i).slice(0, 120).replace(/\n/g, ' | ')}`)
    if (t.tools.length) lines.push(`        tools: ${t.tools.join(', ')}`)
    lines.push(`      < ${t.answer.slice(0, 160).replace(/\n/g, ' | ')}`)
  }
  for (const l of run.residue?.leaks ?? []) lines.push(`  LEAK: ${l.change} ${l.file}`)
  if (run.mod) {
    const byEvent = {}
    for (const s of run.mod.timings) (byEvent[s.event] ??= []).push(s.ms)
    for (const [e, ms] of Object.entries(byEvent)) lines.push(`  mod ${e}: ${ms.length}x, max ${Math.max(...ms)}ms`)
    for (const p of run.mod.problems) lines.push(`  mod PROBLEM: ${p.line.slice(0, 160)}`)
  }
  return lines.join('\n')
}
