// Expectations: what a scenario's runs must show, checked against a run
// record (results.mjs). The format is documented in testbed/README.md.
//
// Two layers:
// - the log layer reads what Claude Code recorded: which hooks ran, how they
//   ended, what they printed, what the user was shown;
// - the model layer reads the model's answer to a question asked in the
//   turn. A log shows a hook ran, not what reached the model, so a delivery
//   claim is only proved by the answer. `{ "none": true }` expects the
//   model to report that nothing arrived.

export const KINDS = ['hook', 'answer', 'shown', 'tools', 'modEvent', 'order', 'budget', 'isolates', 'judge']

export class ExpectError extends Error {}

// ---- matchers ---------------------------------------------------------------

// A string means "includes". Objects: includes, equals, re (+ flags), none,
// not, all, any.
export function checkMatcher(m, where) {
  if (typeof m === 'string') return
  if (!m || typeof m !== 'object') throw new ExpectError(`${where}: a matcher is a string or an object`)
  const keys = Object.keys(m).filter((k) => k !== 'flags')
  if (keys.length !== 1) throw new ExpectError(`${where}: a matcher has exactly one of includes, equals, re, none, not, all, any`)
  const [k] = keys
  if (k === 'includes' || k === 'equals') {
    if (typeof m[k] !== 'string') throw new ExpectError(`${where}.${k} must be a string`)
  } else if (k === 're') {
    try {
      new RegExp(m.re, m.flags ?? '')
    } catch (e) {
      throw new ExpectError(`${where}.re: ${e.message}`)
    }
  } else if (k === 'none') {
    if (m.none !== true) throw new ExpectError(`${where}.none must be true`)
  } else if (k === 'not') {
    checkMatcher(m.not, `${where}.not`)
  } else if (k === 'all' || k === 'any') {
    if (!Array.isArray(m[k]) || m[k].length === 0) throw new ExpectError(`${where}.${k} must be a non-empty array`)
    m[k].forEach((x, i) => checkMatcher(x, `${where}.${k}[${i}]`))
  } else {
    throw new ExpectError(`${where}: unknown matcher ${k}`)
  }
}

// What a model writes when nothing arrived: NONE, maybe with a period,
// quotes, backticks or bold around it.
export function isNone(text) {
  return /^NONE$/i.test(String(text).trim().replace(/^[`"'*_\s]+|[`"'*_.\s]+$/g, ''))
}

export function matches(m, text) {
  text = String(text ?? '')
  if (typeof m === 'string') return text.includes(m)
  if ('includes' in m) return text.includes(m.includes)
  if ('equals' in m) return text.trim() === m.equals
  if ('re' in m) return new RegExp(m.re, m.flags ?? '').test(text)
  if ('none' in m) return isNone(text)
  if ('not' in m) return !matches(m.not, text)
  if ('all' in m) return m.all.every((x) => matches(x, text))
  if ('any' in m) return m.any.some((x) => matches(x, text))
  return false
}

// Where a positive matcher first matches, or -1. Only includes and re have a
// position; `order` accepts only those.
export function locate(m, text) {
  text = String(text ?? '')
  if (typeof m === 'string') return text.indexOf(m)
  if ('includes' in m) return text.indexOf(m.includes)
  if ('re' in m) {
    const r = new RegExp(m.re, (m.flags ?? '').replace('g', ''))
    const x = r.exec(text)
    return x ? x.index : -1
  }
  throw new ExpectError('order items must be includes or re matchers')
}

const describe = (m) => (typeof m === 'string' ? JSON.stringify(m) : JSON.stringify(m))

// ---- validation -------------------------------------------------------------

const SOURCE = /^(answer|shown|hook:[A-Za-z]+)$/

function checkSource(s, where) {
  if (typeof s !== 'string' || !SOURCE.test(s)) throw new ExpectError(`${where}: source must be answer, shown or hook:<Event>`)
}

export function validateExpectation(e, { arms, turns }, where) {
  if (typeof e.id !== 'string' || e.id === '') throw new ExpectError(`${where}.id is required`)
  const kinds = KINDS.filter((k) => k in e)
  if (kinds.length !== 1) throw new ExpectError(`${where}: give exactly one of ${KINDS.join(', ')}`)
  const kind = kinds[0]
  const out = { ...e, kind, arms: e.arms ?? arms }
  for (const a of out.arms) if (!arms.includes(a)) throw new ExpectError(`${where}: arm ${a} is not one of the scenario's arms`)

  if (kind === 'modEvent') {
    if (!out.arms.every((a) => a === 'mod')) throw new ExpectError(`${where}: modEvent applies to the mod arm only; set arms: ["mod"]`)
  } else {
    const t = e.turn
    const ok = t === 'preamble' || t === 'any' || (Number.isInteger(t) && t >= 1 && t <= turns)
    if (!ok) throw new ExpectError(`${where}.turn must be 1..${turns}, "preamble" or "any"`)
  }

  const v = e[kind]
  if (kind === 'hook') {
    if (typeof v.event !== 'string') throw new ExpectError(`${where}.hook.event is required`)
    if (v.name !== undefined) checkMatcher(v.name, `${where}.hook.name`)
    if (v.output !== undefined) checkMatcher(v.output, `${where}.hook.output`)
    if (v.ran === false && (v.output !== undefined || v.silent !== undefined || v.exit !== undefined)) {
      throw new ExpectError(`${where}.hook: ran: false takes no other checks`)
    }
  } else if (kind === 'answer' || kind === 'shown') {
    checkMatcher(v, `${where}.${kind}`)
  } else if (kind === 'tools') {
    if (v.includes !== undefined && !Array.isArray(v.includes)) throw new ExpectError(`${where}.tools.includes must be an array`)
    if (v.max !== undefined && !(Number.isInteger(v.max) && v.max >= 0)) throw new ExpectError(`${where}.tools.max must be a count`)
  } else if (kind === 'modEvent') {
    if (typeof v.event !== 'string') throw new ExpectError(`${where}.modEvent.event is required`)
  } else if (kind === 'order') {
    checkSource(v.in, `${where}.order.in`)
    if (!Array.isArray(v.items) || v.items.length < 2) throw new ExpectError(`${where}.order.items needs two or more`)
    v.items.forEach((m, i) => {
      checkMatcher(m, `${where}.order.items[${i}]`)
      if (typeof m !== 'string' && !('includes' in m) && !('re' in m)) throw new ExpectError(`${where}.order.items[${i}]: use includes or re`)
    })
  } else if (kind === 'budget') {
    checkSource(v.in, `${where}.budget.in`)
    if (v.maxBytes !== undefined && !(Number.isInteger(v.maxBytes) && v.maxBytes > 0)) throw new ExpectError(`${where}.budget.maxBytes must be positive`)
    if (v.lastLine !== undefined) checkMatcher(v.lastLine, `${where}.budget.lastLine`)
    ;(v.present ?? []).forEach((m, i) => checkMatcher(m, `${where}.budget.present[${i}]`))
    ;(v.absent ?? []).forEach((m, i) => checkMatcher(m, `${where}.budget.absent[${i}]`))
  } else if (kind === 'isolates') {
    if (typeof v.event !== 'string' || typeof v.extension !== 'string') throw new ExpectError(`${where}.isolates needs event and extension`)
    ;(v.present ?? []).forEach((m, i) => checkMatcher(m, `${where}.isolates.present[${i}]`))
  } else if (kind === 'judge') {
    if (!Number.isInteger(e.turn)) throw new ExpectError(`${where}: judge needs a numbered turn`)
    if (typeof v.question !== 'string' || typeof v.rubric !== 'string') throw new ExpectError(`${where}.judge needs question and rubric`)
  }
  return out
}

// ---- evaluation -------------------------------------------------------------

function turnsFor(run, turn) {
  if (turn === 'preamble') return [{ index: 'preamble', hooks: run.preamble, answer: '', informational: [], tools: [] }]
  if (turn === 'any') return [{ index: 'preamble', hooks: run.preamble, answer: '', informational: [], tools: [] }, ...run.turns]
  return run.turns.filter((t) => t.index === turn)
}

const hookMatches = (h, v) => h.event === v.event && (v.name === undefined || matches(v.name, h.name))
const ok = (h) => h.status === 'responded' && h.exitCode === 0
// No content for the model or the user: empty output or an empty JSON object.
export const isSilent = (output) => {
  const s = String(output ?? '').trim()
  return s === '' || s === '{}'
}

function sourceText(t, src) {
  if (src === 'answer') return t.answer
  if (src === 'shown') return t.informational.join('\n')
  const event = src.slice('hook:'.length)
  return t.hooks.filter((h) => h.event === event).map((h) => h.output).join('\n')
}

function evalHook(v, ts) {
  const hooks = ts.flatMap((t) => t.hooks).filter((h) => hookMatches(h, v))
  if (v.ran === false) return hooks.length === 0 ? [true, 'did not run'] : [false, `ran ${hooks.length}x`]
  if (hooks.length === 0) return [false, `${v.event} did not run`]
  const failed = hooks.filter((h) => !ok(h))
  if ((v.exit ?? 0) === 0 && failed.length) {
    const h = failed[0]
    return [false, h.status !== 'responded' ? `${h.name}: no response` : `${h.name}: exit ${h.exitCode} (${h.outcome})`]
  }
  if (v.exit !== undefined && v.exit !== 0 && !hooks.some((h) => h.exitCode === v.exit)) return [false, `no exit ${v.exit}`]
  if (v.silent === true && !hooks.every((h) => isSilent(h.output))) return [false, `not silent: ${hooks.find((h) => !isSilent(h.output)).output.slice(0, 80)}`]
  if (v.silent === false && hooks.every((h) => isSilent(h.output))) return [false, 'silent']
  if (v.output !== undefined && !hooks.some((h) => matches(v.output, h.output))) return [false, `output does not match ${describe(v.output)}`]
  return [true, `${hooks.length}x ok`]
}

// The checks a turn-scoped kind runs on one turn's facts.
function evalOnTurn(kind, v, t) {
  if (kind === 'answer') return matches(v, t.answer) ? [true, ''] : [false, `answer: ${JSON.stringify(t.answer.slice(0, 120))}`]
  if (kind === 'shown') return matches(v, t.informational.join('\n')) ? [true, ''] : [false, `shown: ${JSON.stringify(t.informational.join(' | ').slice(0, 120))}`]
  if (kind === 'tools') {
    const missing = (v.includes ?? []).filter((x) => !t.tools.includes(x))
    if (missing.length) return [false, `no ${missing.join(', ')} call (tools: ${t.tools.join(', ') || 'none'})`]
    if (v.max !== undefined && t.tools.length > v.max) return [false, `${t.tools.length} tool calls, max ${v.max}`]
    return [true, `${t.tools.length} tool calls`]
  }
  if (kind === 'order') {
    // Presence first: a missing item has position -1, which would sort
    // before everything and pass an order check by accident.
    const text = sourceText(t, v.in)
    const at = v.items.map((m) => locate(m, text))
    const missing = v.items.filter((_, i) => at[i] < 0)
    if (missing.length) return [false, `missing in ${v.in}: ${missing.map(describe).join(', ')}`]
    for (let i = 1; i < at.length; i++) if (at[i] <= at[i - 1]) return [false, `${describe(v.items[i])} comes before ${describe(v.items[i - 1])}`]
    return [true, '']
  }
  if (kind === 'budget') {
    const text = sourceText(t, v.in)
    if (text === '') return [false, `${v.in} is empty`]
    const bytes = Buffer.byteLength(text)
    if (v.maxBytes !== undefined && bytes > v.maxBytes) return [false, `${bytes} bytes > ${v.maxBytes}`]
    if (v.lastLine !== undefined) {
      const last = text.trimEnd().split('\n').pop()
      if (!matches(v.lastLine, last)) return [false, `last line ${JSON.stringify(last.slice(0, 80))} does not match ${describe(v.lastLine)}`]
    }
    const missing = (v.present ?? []).filter((m) => !matches(m, text))
    if (missing.length) return [false, `missing: ${missing.map(describe).join(', ')}`]
    const kept = (v.absent ?? []).filter((m) => matches(m, text))
    if (kept.length) return [false, `should have been dropped: ${kept.map(describe).join(', ')}`]
    return [true, `${bytes} bytes`]
  }
  if (kind === 'isolates') {
    // The hook still succeeded, its output names the failed extension, and
    // the other extensions' sections are still there.
    const hooks = t.hooks.filter((h) => h.event === v.event)
    if (hooks.length === 0) return [false, `${v.event} did not run`]
    const bad = hooks.find((h) => !ok(h))
    if (bad) return [false, `${v.event} failed: exit ${bad.exitCode}`]
    const text = hooks.map((h) => h.output).join('\n')
    if (!text.includes(v.extension)) return [false, `output does not name ${v.extension}`]
    const missing = (v.present ?? []).filter((m) => !matches(m, text))
    if (missing.length) return [false, `other sections missing: ${missing.map(describe).join(', ')}`]
    return [true, '']
  }
  throw new ExpectError(`unknown kind ${kind}`)
}

export function evaluate(e, run, verdicts = {}) {
  const base = { id: e.id, kind: e.kind, turn: e.turn ?? null }
  if (!run.valid) return { ...base, pass: false, detail: `run invalid: ${run.armCheck.reason}` }
  const v = e[e.kind]
  if (e.kind === 'modEvent') {
    const times = (run.mod?.timings ?? []).filter((x) => x.event === v.event)
    const min = v.min ?? 1
    if (times.length < min) return { ...base, pass: false, detail: `${v.event} settled ${times.length}x, expected at least ${min}` }
    const max = Math.max(...times.map((x) => x.ms), 0)
    if (v.maxMs !== undefined && max > v.maxMs) return { ...base, pass: false, detail: `${v.event} took ${max}ms > ${v.maxMs}` }
    return { ...base, pass: true, detail: `${times.length}x, max ${max}ms` }
  }
  const ts = turnsFor(run, e.turn)
  if (ts.length === 0) return { ...base, pass: false, detail: `turn ${e.turn} is not in the run (${run.turns.length} turns)` }
  if (e.kind === 'hook') {
    const [pass, detail] = evalHook(v, ts)
    return { ...base, pass, detail }
  }
  if (e.kind === 'judge') {
    const key = `${run.scenario}/${run.arm}/${e.id}`
    if (!(key in verdicts)) return { ...base, pass: null, detail: 'awaiting the blind grader' }
    return { ...base, pass: verdicts[key] === true, detail: 'blind grader' }
  }
  // 'any' passes when one turn passes; a numbered turn is one turn.
  let last = [false, '']
  for (const t of ts) {
    last = evalOnTurn(e.kind, v, t)
    if (last[0]) break
  }
  return { ...base, pass: last[0], detail: last[1] }
}
