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

export const KINDS = ['hook', 'answer', 'shown', 'tools', 'modEvent', 'order', 'budget', 'meter', 'isolates', 'judge']

// The session-start meter line, as the vendored hook-io writes it:
//   _context injected: 2.5kB / 9.1kB budget — collapsed: A, B_
// with optional "(N configured, held under the hook output cap)" after the
// budget, then " — "-separated segments: "collapsed: A, B", "degraded:
// C (headlines)" (a section below full but above its pointer), "truncated
// to fit …". Sizes are kB to one decimal. A segment the parser doesn't know
// is kept in `other`, so a new one never makes the whole line unreadable.
const METER_HEAD = /^([\d.]+)kB(?: \/ ([\d.]+)kB budget)?(?: \(([\d.]+)kB configured[^)]*\))?$/

export function parseMeter(line) {
  const text = String(line ?? '').trim()
  if (!text.startsWith('_context injected: ') || !text.endsWith('_')) return null
  const [head, ...segments] = text.slice('_context injected: '.length, -1).split(' — ')
  const m = METER_HEAD.exec(head)
  if (!m) return null
  const kB = (s) => (s === undefined ? null : Math.round(Number(s) * 1000))
  const out = { bytes: kB(m[1]), budget: kB(m[2]), configured: kB(m[3]), collapsed: [], degraded: [], truncated: false, other: [] }
  for (const seg of segments) {
    if (seg.startsWith('collapsed: ')) out.collapsed.push(...seg.slice('collapsed: '.length).split(', '))
    else if (seg.startsWith('degraded: ')) out.degraded.push(...seg.slice('degraded: '.length).split(', '))
    else if (seg.startsWith('truncated to fit ')) out.truncated = true
    else out.other.push(seg)
  }
  return out
}

// How far the meter says a section was cut. The meter names a section cut
// below full but above its pointer as `degraded: <Section> → <level>`
// (levels: focus, headlines, top-N), and a section cut to its pointer by
// its bare name under `collapsed:`. A section it names nowhere is "full".
// An arrow form under collapsed: is read too, so a meter that ever writes
// `<Section> → pointer` there still parses.
export function sectionLevel(meter, name) {
  const levelIn = (entries) => {
    for (const e of entries) {
      if (e === name) return 'pointer'
      if (e.startsWith(`${name} → `)) return e.slice(name.length + 3)
    }
    return null
  }
  return levelIn(meter.degraded) ?? levelIn(meter.collapsed) ?? 'full'
}

// The meter rounds to 0.1 kB, so a reported size can sit up to 50 bytes
// either side of the real one.
const METER_ROUNDING = 50

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
    const ok = t === 'preamble' || t === 'any' || t === 'all' || (Number.isInteger(t) && t >= 1 && t <= turns)
    if (!ok) throw new ExpectError(`${where}.turn must be 1..${turns}, "preamble", "any" or "all"`)
  }

  const v = e[kind]
  if (kind === 'hook') {
    if (typeof v.event !== 'string') throw new ExpectError(`${where}.hook.event is required`)
    if (v.name !== undefined) checkMatcher(v.name, `${where}.hook.name`)
    if (v.output !== undefined) checkMatcher(v.output, `${where}.hook.output`)
    if (v.everyOutput !== undefined) checkMatcher(v.everyOutput, `${where}.hook.everyOutput`)
    // "any" means one passing turn is enough; silence on one turn says
    // nothing about the others, so the spec has to say "all".
    if (v.silent === true && e.turn === 'any') {
      throw new ExpectError(`${where} (${e.id}): hook.silent: true on turn "any" would pass on one silent turn; use turn "all"`)
    }
    if (v.ran === false && (v.output !== undefined || v.everyOutput !== undefined || v.silent !== undefined || v.exit !== undefined)) {
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
  } else if (kind === 'meter') {
    checkSource(v.in, `${where}.meter.in`)
    if (v.maxBytes !== undefined && !(Number.isInteger(v.maxBytes) && v.maxBytes > 0)) throw new ExpectError(`${where}.meter.maxBytes must be positive`)
    if (v.collapsed !== undefined && !(Array.isArray(v.collapsed) && v.collapsed.every((c) => typeof c === 'string'))) {
      throw new ExpectError(`${where}.meter.collapsed must be a list of section names`)
    }
    // sections may be left out when which sections get cut isn't the point:
    // the meter's numbers are still held to what arrived.
    if (v.sections !== undefined && !Array.isArray(v.sections)) throw new ExpectError(`${where}.meter.sections must be a list`)
    ;(v.sections ?? []).forEach((s, i) => {
      if (typeof s.name !== 'string') throw new ExpectError(`${where}.meter.sections[${i}].name is required`)
      checkMatcher(s.body, `${where}.meter.sections[${i}].body`)
    })
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

// The turns an expectation reads. The preamble (hooks before the first
// prompt) counts as a turn for hook expectations only: it has no answer,
// nothing shown and no tools.
function turnsFor(run, turn, kind) {
  const preamble = { index: 'preamble', hooks: run.preamble, answer: '', informational: [], tools: [] }
  if (turn === 'preamble') return [preamble]
  if (turn === 'any' || turn === 'all') return kind === 'hook' ? [preamble, ...run.turns] : run.turns
  return run.turns.filter((t) => t.index === turn)
}

const hookMatches = (h, v) => h.event === v.event && (v.name === undefined || matches(v.name, h.name))
const ok = (h) => h.status === 'responded' && h.exitCode === 0
// No content for the model or the user: empty output or an empty JSON object.
export const isSilent = (output) => {
  const s = String(output ?? '').trim()
  return s === '' || s === '{}'
}

export function sourceText(t, src) {
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
  // output: at least one run's output matches. everyOutput: every run's
  // does, which is what a negative ("no MF- marker anywhere") needs.
  if (v.output !== undefined && !hooks.some((h) => matches(v.output, h.output))) return [false, `output does not match ${describe(v.output)}`]
  if (v.everyOutput !== undefined) {
    const off = hooks.find((h) => !matches(v.everyOutput, h.output))
    if (off) return [false, `a ${off.name} output does not match ${describe(v.everyOutput)}: ${JSON.stringify(off.output.slice(0, 80))}`]
  }
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
  if (kind === 'meter') {
    // The meter's own numbers, held to the truth: the size it reports fits
    // the budget, the bytes really delivered fit maxBytes, and every section
    // it says it collapsed lost its body while every other kept it.
    const text = sourceText(t, v.in)
    if (text === '') return [false, `${v.in} is empty`]
    const last = text.trimEnd().split('\n').pop()
    const m = parseMeter(last)
    if (!m) return [false, `last line is not a meter: ${JSON.stringify(last.slice(0, 80))}`]
    if (m.truncated) return [false, 'the meter says the output was truncated']
    if (m.budget === null) return [false, 'the meter reports no budget']
    if (m.bytes > m.budget) return [false, `meter reports ${m.bytes} bytes over its ${m.budget}-byte budget`]
    const actual = Buffer.byteLength(text)
    if (v.maxBytes !== undefined) {
      if (m.bytes > v.maxBytes) return [false, `meter reports ${m.bytes} bytes > ${v.maxBytes}`]
      if (actual > v.maxBytes) return [false, `${actual} bytes delivered > ${v.maxBytes}`]
    }
    if (m.bytes > actual + METER_ROUNDING) return [false, `meter reports ${m.bytes} bytes but only ${actual} arrived`]
    if (v.collapsed !== undefined) {
      const want = [...v.collapsed].sort()
      const got = [...m.collapsed].sort()
      if (want.join('\u0000') !== got.join('\u0000')) return [false, `meter collapsed [${m.collapsed.join(', ')}], expected [${v.collapsed.join(', ')}]`]
    }
    for (const s of v.sections ?? []) {
      const named = m.collapsed.includes(s.name)
      const present = matches(s.body, text)
      if (named && present) return [false, `meter names ${s.name} as collapsed, but its body arrived`]
      if (!named && !present) return [false, `${s.name} is missing, and the meter doesn't name it`]
    }
    return [true, `${m.bytes}/${m.budget} bytes, collapsed [${m.collapsed.join(', ')}]`]
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
  const ts = turnsFor(run, e.turn, e.kind)
  if (ts.length === 0) return { ...base, pass: false, detail: `turn ${e.turn} is not in the run (${run.turns.length} turns)` }
  if (e.kind === 'hook' && e.turn !== 'any') {
    // One turn, or "all": every run of the hook across the turns at once.
    const [pass, detail] = evalHook(v, ts)
    return { ...base, pass, detail }
  }
  if (e.kind === 'judge') {
    const key = `${run.scenario}/${run.arm}/${e.id}`
    if (!(key in verdicts)) return { ...base, pass: null, detail: 'awaiting the blind grader' }
    return { ...base, pass: verdicts[key] === true, detail: 'blind grader' }
  }
  const check = (t) => (e.kind === 'hook' ? evalHook(v, [t]) : evalOnTurn(e.kind, v, t))
  if (e.turn === 'all') {
    // Every turn passes; the first that doesn't is the detail.
    for (const t of ts) {
      const [pass, detail] = check(t)
      if (!pass) return { ...base, pass: false, detail: `turn ${t.index}: ${detail}` }
    }
    return { ...base, pass: true, detail: `${ts.length} turns` }
  }
  // "any" passes when one turn passes; a numbered turn is one turn.
  let last = [false, '']
  for (const t of ts) {
    last = check(t)
    if (last[0]) break
  }
  return { ...base, pass: last[0], detail: last[1] }
}
