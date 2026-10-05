// Drives one headless Claude Code session in a bed: turns go in as
// stream-json user messages, one at a time, each sent only after the
// previous turn's `result`. Sending them unpaced folds several prompts into
// one turn, and a per-turn expectation becomes meaningless.
import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { writeFixture } from './bed.mjs'

// The flags every bed session runs with, and why:
// - stream-json in and out keeps one session across turns, so per-session
//   hook state (dedupe, handoff files) is exercised; output needs --verbose;
// - --include-hook-events puts each settings hook's start and response in
//   the stream; --replay-user-messages echoes each turn's prompt;
// - --setting-sources project,local loads the bed's hooks and not the
//   machine's own; an empty strict MCP config keeps the machine's servers out;
// - --debug-file is where the mod's modules log loading and timings.
// The mod arm loads the bed's mod with --plugin-dir, which needs no trust. A
// bed is never trusted, so on the settings arm a mod shipped in
// .claude/skills/ stays unloaded.
export function claudeArgs({ arm, bed, mod, session, debugFile }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-hook-events',
    '--replay-user-messages',
    '--model', session.model,
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--debug-file', debugFile,
    '--max-budget-usd', String(session.maxBudgetUsd),
  ]
  if (session.allowedTools.length) args.push('--allowedTools', session.allowedTools.join(','))
  if (arm === 'mod') args.push('--plugin-dir', path.join(bed, ...mod.dir.split('/')))
  return args
}

export function userMessage(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
}

export function applyAction(bed, a) {
  if ('append' in a) {
    const file = path.join(bed, ...a.append.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, (a.char ?? 'y').repeat(a.bytes))
  } else if ('write' in a) {
    writeFixture(bed, { path: a.write, content: a.content })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, timeoutMs, child) {
  const end = Date.now() + timeoutMs
  while (!cond()) {
    if (child.exitCode !== null) return 'exited'
    if (Date.now() > end) return 'timeout'
    await sleep(100)
  }
  return 'ok'
}

// cmd is the claude binary and any leading arguments, so tests can run a
// stand-in: [process.execPath, 'fake-claude.mjs'].
export async function runSession({ cmd = ['claude'], arm, bed, mod, session, turns, logDir, name }) {
  mkdirSync(logDir, { recursive: true })
  const files = {
    stream: path.join(logDir, `${name}.jsonl`),
    debug: path.join(logDir, `${name}.debug`),
    stderr: path.join(logDir, `${name}.err`),
  }
  const args = [...cmd.slice(1), ...claudeArgs({ arm, bed, mod, session, debugFile: files.debug })]
  const child = spawn(cmd[0], args, {
    cwd: bed,
    env: { ...process.env, DISABLE_AUTOUPDATER: '1', ...session.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const out = createWriteStream(files.stream)
  const err = createWriteStream(files.stderr)
  let results = 0
  let buf = ''
  child.stdout.on('data', (d) => {
    out.write(d)
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.includes('"type":"result"')) {
        try {
          if (JSON.parse(line).type === 'result') results++
        } catch {}
      }
    }
  })
  child.stderr.pipe(err)
  const exited = new Promise((r) => child.on('close', (code) => r(code)))
  child.stdin.on('error', () => {}) // the session may exit before stdin closes

  const log = []
  for (const [i, turn] of turns.entries()) {
    if (i > 0) {
      const waited = await until(() => results >= i, session.turnTimeoutMs, child)
      if (waited !== 'ok') {
        log.push({ turn: i, stopped: waited })
        break
      }
      await sleep(session.gapMs)
    }
    for (const a of turn.before) applyAction(bed, a)
    child.stdin.write(userMessage(turn.text))
    log.push({ turn: i, sent: Date.now() })
  }
  const last = await until(() => results >= turns.length, session.turnTimeoutMs, child)
  if (last === 'ok') await sleep(session.settleMs) // events that follow the last result
  else if (!log.some((l) => l.stopped)) log.push({ turn: turns.length, stopped: last })
  child.stdin.end()
  const killer = setTimeout(() => child.kill(), 30000)
  const code = await exited
  clearTimeout(killer)
  await Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))])
  writeFileSync(path.join(logDir, `${name}.feed.json`), JSON.stringify(log, null, 1))
  return { code, files, results, feed: log }
}
