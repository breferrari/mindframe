# Roadmap

The build order. Each phase is a [GitHub milestone](https://github.com/breferrari/mindframe/milestones), and each row is one issue, closed by one PR. Update a row in the PR that closes its issue.

Status: ✅ done · 🔨 in progress · ⏳ blocked · ⬜ not started

## Phase 1: basics and test bed

| Issue | What | Status |
|-------|------|--------|
| [#1](https://github.com/breferrari/mindframe/pull/1) | Repo rules (`CONTRIBUTING.md`) and CI on three OSes | ✅ |
| [#2](https://github.com/breferrari/mindframe/issues/2) | Roadmap and design rationale (`docs/DESIGN.md`) | ✅ |
| [#3](https://github.com/breferrari/mindframe/issues/3) | Test bed runner: beds, paced sessions on both arms, per-hook results | ✅ |
| [#4](https://github.com/breferrari/mindframe/issues/4) | Expectation spec format and grader | ✅ |
| [#5](https://github.com/breferrari/mindframe/issues/5) | obsidian-mind baseline run, on Windows and one POSIX OS | ⬜ |

## Phase 2: the core

Starts when the registry prototype in [wiki-mind](https://github.com/breferrari/wiki-mind) and its real-session test bed have passed. The contract is in [`docs/DESIGN.md`](docs/DESIGN.md).

| Issue | What | Status |
|-------|------|--------|
| [#6](https://github.com/breferrari/mindframe/issues/6) | Lift the extension registry from wiki-mind | ⏳ |
| [#7](https://github.com/breferrari/mindframe/issues/7) | Core hook I/O and output budget | ⬜ |
| [#8](https://github.com/breferrari/mindframe/issues/8) | Vault-root discovery, the mod and the `om_mod` flag protocol | ⬜ |
| [#9](https://github.com/breferrari/mindframe/issues/9) | Frontmatter and wikilink libraries | ⬜ |
| [#10](https://github.com/breferrari/mindframe/issues/10) | `VENDOR.json` and the vendor drift check | ⬜ |
| [#11](https://github.com/breferrari/mindframe/issues/11) | Test bed: core contract scenarios (ordering, budget, isolation) | ⬜ |
| [#12](https://github.com/breferrari/mindframe/issues/12) | Test bed: wiki-mind spec | ⏳ |

## Phase 3: first-party extensions

| Issue | What | Status |
|-------|------|--------|
| [#13](https://github.com/breferrari/mindframe/issues/13) | qmd | ⬜ |
| [#14](https://github.com/breferrari/mindframe/issues/14) | Memory MCP server | ⬜ |
| [#15](https://github.com/breferrari/mindframe/issues/15) | Guards | ⬜ |
| [#16](https://github.com/breferrari/mindframe/issues/16) | Ripple | ⬜ |
| [#17](https://github.com/breferrari/mindframe/issues/17) | Iconize | ⬜ |

## Phase 4: obsidian-mind adopts mindframe

| Issue | What | Status |
|-------|------|--------|
| [#18](https://github.com/breferrari/mindframe/issues/18) | obsidian-mind's behaviour as extensions | ⬜ |
| [#19](https://github.com/breferrari/mindframe/issues/19) | obsidian-mind vendors mindframe | ⬜ |
| [#20](https://github.com/breferrari/mindframe/issues/20) | Test bed: obsidian-mind before and after | ⬜ |
