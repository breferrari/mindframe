// Builds a bed: a fresh folder holding a vault's infrastructure (never its
// notes), the spec's fixtures, and a git history of one commit. Several hook
// sections read git, so fixtures are committed to keep them from showing up
// as uncommitted changes.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const git = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', ...opts })

// Tracked and untracked files (uncommitted work is what a run tests), minus
// ignored ones, limited to the include list. '.' means the whole tree.
export function infrastructureFiles(vault, include) {
  const spec = include.includes('.') ? ['.'] : include
  const out = git(vault, ['ls-files', '-co', '--exclude-standard', '-z', '--', ...spec])
  return out.split('\0').filter((f) => f && !f.split('/').includes('node_modules'))
}

const toNative = (root, posix) => path.join(root, ...posix.split('/'))

export function writeFixture(bed, f) {
  const file = toNative(bed, f.path)
  mkdirSync(path.dirname(file), { recursive: true })
  if ('content' in f) writeFileSync(file, f.content)
  else writeFileSync(file, (f.header ?? '') + (f.char ?? 'x').repeat(f.fill))
}

// The bed folder must not exist: the builder never overwrites or deletes.
export function buildBed({ vault, bed, spec }) {
  if (existsSync(bed)) throw new Error(`bed folder exists, pick a new one: ${bed}`)
  const files = infrastructureFiles(vault, spec.bed.include)
  mkdirSync(bed, { recursive: true })
  for (const f of files) {
    const src = toNative(vault, f)
    if (!existsSync(src)) continue // listed by git but deleted in the working tree
    const dst = toNative(bed, f)
    mkdirSync(path.dirname(dst), { recursive: true })
    cpSync(src, dst)
  }
  for (const c of spec.bed.copy) {
    const src = toNative(vault, c)
    if (existsSync(src)) cpSync(src, toNative(bed, c), { recursive: true, verbatimSymlinks: true })
  }
  for (const f of spec.bed.fixtures) writeFixture(bed, f)

  git(bed, ['init', '-q'])
  git(bed, ['config', 'user.email', 'bed@example.com'])
  git(bed, ['config', 'user.name', 'bed'])
  git(bed, ['config', 'core.autocrlf', 'false'])
  git(bed, ['add', '-A'])
  git(bed, ['commit', '-q', '--no-gpg-sign', '-m', 'bed'])
  return { files: files.length }
}

// The vault's commit, recorded with each run; null when it isn't a git repo.
export function vaultCommit(vault) {
  try {
    const head = git(vault, ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = git(vault, ['status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== ''
    return { head, dirty }
  } catch {
    return null
  }
}
