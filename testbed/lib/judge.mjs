// The blind grader, for questions a pattern can't settle ("did the answer
// apply the user's own rule?"). `prepare` collects every judged answer,
// shuffles them and strips scenario and arm, so the grader can't favour an
// arm. One tool-less model call grades the lot against each question's
// rubric. `apply` maps the verdicts back through a key the grader never
// sees. Deterministic expectations stay with the deterministic grader.

export function prepare(record, spec, random = Math.random) {
  const items = []
  for (const s of spec.scenarios) {
    for (const e of (s.expect ?? []).filter((x) => x.kind === 'judge')) {
      for (const arm of e.arms) {
        const run = record.runs.find((r) => r.scenario === s.id && r.arm === arm)
        if (!run || !run.valid) continue
        const turn = run.turns.find((t) => t.index === e.turn)
        if (!turn) continue
        items.push({ ref: `${s.id}/${arm}/${e.id}`, question: e.judge.question, rubric: e.judge.rubric, answer: turn.answer })
      }
    }
  }
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  const key = {}
  const blind = items.map((it, k) => {
    key[k] = it.ref
    return { key: k, question: it.question, rubric: it.rubric, answer: it.answer }
  })
  return { blind, key, prompt: promptFor(blind) }
}

export function promptFor(blind) {
  return [
    'You are grading answers from an AI assistant, blind. You do not know which system produced any answer.',
    "Judge each answer only against its own rubric. Do not judge quality, tone or anything the rubric doesn't ask.",
    '',
    'Return ONLY a JSON array, no prose, one object per item, in any order: {"key": <key>, "pass": true|false}.',
    '',
    'Items:',
    JSON.stringify(blind, null, 1),
  ].join('\n')
}

// verdicts: the grader's JSON array. Returns { "<scenario>/<arm>/<id>": bool }.
// Every item must be graded exactly once, or the whole set is refused.
export function apply(key, verdicts) {
  if (!Array.isArray(verdicts)) throw new Error('verdicts must be a JSON array')
  const out = {}
  for (const v of verdicts) {
    const ref = key[v.key]
    if (ref === undefined) throw new Error(`verdict for unknown key ${v.key}`)
    if (ref in out) throw new Error(`key ${v.key} graded twice`)
    if (typeof v.pass !== 'boolean') throw new Error(`key ${v.key}: pass must be true or false`)
    out[ref] = v.pass
  }
  const missing = Object.keys(key).filter((k) => !(key[k] in out))
  if (missing.length) throw new Error(`no verdict for key(s) ${missing.join(', ')}`)
  return out
}
