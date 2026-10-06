# mindframe

The agent layer for Obsidian vaults that work with Claude Code. It has three parts:
- a small **core**: the extension registry, hook I/O and the output budget, vault-root discovery, the mod and its `om_mod` flag, and vendoring;
- optional **extensions**;
- a **test bed** that runs vaults' hooks and mod, live or dry, and grades them against a spec.

Vaults vendor it and extend it without editing the core.

Every rule for working here is in [CONTRIBUTING.md](CONTRIBUTING.md). Read it before changing anything. The design contract is [docs/DESIGN.md](docs/DESIGN.md), and the build order is [ROADMAP.md](ROADMAP.md).

## Hard rules

1. **No agent-session artifacts:** no claude.ai session URLs, no `Claude-Session:` trailers and no local absolute paths, in commits, PRs, issues or files.
2. **No commercial reasoning:** no competitors, positioning, naming rationale or product comparisons. Design rationale is welcome.
3. **No AI in CI, ever:** CI is deterministic. Live model sessions are research, run locally with the maintainer's go, never a gate.
4. **Branch and PR for everything:** no stacked PRs, titles `type: short description`.
5. **LF line endings, and Windows, macOS and Linux all supported:** paths via path APIs.

## Layout

Update this table in the PR that adds or removes a top-level path.

| Path | What |
|------|------|
| `core/scripts/` | The core as a vault carries it, mirroring `.claude/scripts/`: `core/` (the extension registry, types, public `index.ts`, QMD session work) and `lib/` (hook I/O, the budget, qmd, wikilinks). Lifted from wiki-mind; see its README |
| `core/vendor/` | The `VENDOR.json` record and offline drift check |
| `testbed/` | Runs a vault's hooks and mod in real or dry sessions and grades them: `bin/`, `lib/`, `specs/`, `fixtures/`, `ci/pins.json`, tests |
| `docs/DESIGN.md` | The core's contract, rule by rule, with the failure each prevents |
| `ROADMAP.md` | Phases as milestones, one issue per row |
| `CONTRIBUTING.md` | Every rule for working on the repo |
| `.github/workflows/` | CI on three OSes: LF, artifact grep, typecheck, tests, dry runs of every spec; PR titles |
| `package.json`, `tsconfig.json` | `npm test`, and the core's typecheck (strip-types, erasable syntax only) |
| `README.md`, `LICENSE`, `.gitattributes`, `.gitignore` | Landing page, MIT, LF pinning, ignores |
