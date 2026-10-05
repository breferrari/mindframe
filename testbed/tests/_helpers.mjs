import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
export const FAKE_CLAUDE = [process.execPath, path.join(FIXTURES, 'fake-claude.mjs')]

// A temp folder removed when the test ends.
export function tmp(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mf-bed-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function write(root, rel, content) {
  const file = path.join(root, ...rel.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

// A small vault: infrastructure, private notes, an untracked script (work in
// progress a run must see), an ignored state file and a node_modules tree.
export function makeVault(t) {
  const v = path.join(tmp(t), 'vault')
  mkdirSync(v)
  const git = (...a) => execFileSync('git', a, { cwd: v, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  write(v, '.gitignore', '.claude/state.json\nnode_modules/\n')
  write(v, 'vault-manifest.json', '{"template":"demo"}\n')
  write(v, 'CLAUDE.md', '# Manual\n')
  write(v, '.claude/settings.json', '{"hooks":{}}\n')
  write(v, '.claude/scripts/hook.ts', 'export {}\n')
  write(v, '.claude/skills/demo-mod/hooks/hooks.json', '{"modules":["./register.ts"]}\n')
  write(v, 'notes/private.md', 'a private note\n')
  write(v, 'brain/Goals.md', 'private goals\n')
  git('add', '-A')
  git('commit', '-q', '--no-gpg-sign', '-m', 'vault')
  write(v, '.claude/scripts/new-hook.ts', 'export const wip = 1\n')
  write(v, '.claude/state.json', '{}\n')
  write(v, '.claude/scripts/node_modules/dep/index.js', 'module.exports = 1\n')
  return v
}

export const minimalSpec = (extra = {}) => ({
  name: 'demo',
  mod: { dir: '.claude/skills/demo-mod', name: 'fake-mod' },
  session: { gapMs: 0, settleMs: 0, turnTimeoutMs: 10000 },
  scenarios: [{ id: 'basic', turns: ['Say only: one.', 'Say only: two.'] }],
  ...extra,
})
