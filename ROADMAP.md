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
| [#5](https://github.com/breferrari/mindframe/issues/5) | Run the obsidian-mind baseline spec in real sessions | 🔨 Windows done; POSIX leg pending |
| [#74](https://github.com/breferrari/mindframe/issues/74) | Let expectations read the mod's delivery in dry runs, and dry-run it in CI | ✅ |

## Phase 2: the core

Starts when the registry prototype in [wiki-mind](https://github.com/breferrari/wiki-mind) and its real-session test bed have passed. The contract is in [`docs/DESIGN.md`](docs/DESIGN.md).

| Issue | What | Status |
|-------|------|--------|
| [#6](https://github.com/breferrari/mindframe/issues/6) | Lift the extension registry from wiki-mind | ✅ |
| [#7](https://github.com/breferrari/mindframe/issues/7) | Core hook I/O and output budget | ✅ |
| [#8](https://github.com/breferrari/mindframe/issues/8) | Vault-root discovery, the mod and the `om_mod` flag protocol | ✅ (the mod template: #47) |
| [#9](https://github.com/breferrari/mindframe/issues/9) | Frontmatter and wikilink libraries | ✅ |
| [#10](https://github.com/breferrari/mindframe/issues/10) | `VENDOR.json` and the vendor drift check | ✅ |
| [#11](https://github.com/breferrari/mindframe/issues/11) | Run the core contract scenarios in real sessions | ✅ |
| [#12](https://github.com/breferrari/mindframe/issues/12) | Run the wiki-mind spec in real sessions | ✅ |
| [#52](https://github.com/breferrari/mindframe/issues/52) | Let session-start's budget and QMD readers take the parsed manifest | ✅ |
| [#63](https://github.com/breferrari/mindframe/issues/63) | Find frontmatter by its delimiter lines, not every `---` | ✅ |
| [#67](https://github.com/breferrari/mindframe/issues/67) | Make the CRLF frontmatter test fail when CRLF isn't parsed | ✅ |
| [#75](https://github.com/breferrari/mindframe/issues/75) | Export an atomic write to extensions from the core | ✅ |
| [#77](https://github.com/breferrari/mindframe/issues/77) | Close a fence only on a run as long as its opening, as CommonMark does | ✅ |
| [#78](https://github.com/breferrari/mindframe/issues/78) | Let vendor update bring in files the updated ones need | ✅ |
| [#79](https://github.com/breferrari/mindframe/issues/79) | Retry the atomic write's rename on Windows, and hide and uniquify its temp file | ✅ |
| [#80](https://github.com/breferrari/mindframe/issues/80) | Export line regions and wikilink offsets to extensions | ✅ |
| [#82](https://github.com/breferrari/mindframe/issues/82) | Read frontmatter by one rule everywhere in the core, as Obsidian does | ✅ |
| [#85](https://github.com/breferrari/mindframe/issues/85) | Export the vault-root walk-up to extensions | ✅ |
| [#89](https://github.com/breferrari/mindframe/issues/89) | Absorb obsidian-mind #333 into the core: the instruction files library and its comments | ✅ |
| [#91](https://github.com/breferrari/mindframe/issues/91) | Match a retired instruction file the way the agent loads it: any case where the filesystem ignores case, exact case on Linux | ⬜ |

## Phase 3: first-party extensions

| Issue | What | Status |
|-------|------|--------|
| [#13](https://github.com/breferrari/mindframe/issues/13) | Ship qmd as an optional extension | 🔨 split into #69, #70, #71 |
| [#69](https://github.com/breferrari/mindframe/issues/69) | Let extensions run side effects, and add a pre-compact event | ✅ |
| [#70](https://github.com/breferrari/mindframe/issues/70) | Move qmd out of the core into an optional extension | ⏳ after #69, and the obsidian-mind #321 absorb with #52 |
| [#71](https://github.com/breferrari/mindframe/issues/71) | Ship the qmd MCP bridge with the qmd extension | ⏳ after #70 |
| [#94](https://github.com/breferrari/mindframe/issues/94) | Skip session-start's detached qmd refresh when VAULT_QMD_REFRESH=off, as obsidian-mind #338 does | ✅ |
| [#95](https://github.com/breferrari/mindframe/issues/95) | Run qmd's index refresh as the qmd extension's effects | ⏳ after #70 |
| [#96](https://github.com/breferrari/mindframe/issues/96) | Move qmd's bootstrap and model setup into the qmd extension | ⏳ after #95 |
| [#14](https://github.com/breferrari/mindframe/issues/14) | Ship the memory MCP server as an optional extension | ⬜ |
| [#15](https://github.com/breferrari/mindframe/issues/15) | Ship the guards as an optional extension | ⬜ |
| [#16](https://github.com/breferrari/mindframe/issues/16) | Ship ripple as an optional extension | ⬜ |
| [#17](https://github.com/breferrari/mindframe/issues/17) | Ship iconize as an optional extension | ⬜ |

## Phase 4: obsidian-mind adopts mindframe

| Issue | What | Status |
|-------|------|--------|
| [#18](https://github.com/breferrari/mindframe/issues/18) | Rewrite obsidian-mind's own behaviour as extensions | ⬜ |
| [#19](https://github.com/breferrari/mindframe/issues/19) | Vendor mindframe into obsidian-mind | ⬜ |
| [#20](https://github.com/breferrari/mindframe/issues/20) | Rerun the obsidian-mind baseline spec after obsidian-mind adopts mindframe | ⬜ |
| [#45](https://github.com/breferrari/mindframe/issues/45) | Move the Stop flow into the core for every vault | ⬜ |
| [#46](https://github.com/breferrari/mindframe/issues/46) | Split obsidian-mind's formatters out of lib/session-start (S2) | ⬜ |
| [#47](https://github.com/breferrari/mindframe/issues/47) | Generate each vault's mod from one template | ⬜ |
