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
| [#99](https://github.com/breferrari/mindframe/issues/99) | Fail a test bed run that leaves a detached process behind, and move the pins past VAULT_QMD_REFRESH | ⬜ |
| [#129](https://github.com/breferrari/mindframe/issues/129) | Grade a hook's context as the agent receives it: the test bed unwraps the SessionStart JSON envelope | ✅ |

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
| [#102](https://github.com/breferrari/mindframe/issues/102) | Record obsidian-mind as upstream for the core libraries absorbed from it | ✅ |
| [#91](https://github.com/breferrari/mindframe/issues/91) | Match a retired instruction file the way the agent loads it: any case where the filesystem ignores case, exact case on Linux | ✅ |
| [#104](https://github.com/breferrari/mindframe/issues/104) | Retire GEMINI.md only where the vault points Gemini at AGENTS.md: a vault-aware retired-file predicate | ✅ |
| [#107](https://github.com/breferrari/mindframe/issues/107) | Read a heading on a note's first line after a BOM: lineRegions strips a line-0 BOM | ⬜ |
| [#110](https://github.com/breferrari/mindframe/issues/110) | Report an extension field whose getter throws, instead of letting it escape the dispatch | ✅ |
| [#111](https://github.com/breferrari/mindframe/issues/111) | Return the migration notes from openVault, so no entry point calls migrationNotes itself | ✅ |
| [#112](https://github.com/breferrari/mindframe/issues/112) | Probe the vault root's filesystem for case sensitivity, in place of the platform guess | ⬜ |
| [#114](https://github.com/breferrari/mindframe/issues/114) | Emit the session context from one core function, in place of each entry point's four paired delivery choices | ⬜ |
| [#115](https://github.com/breferrari/mindframe/issues/115) | Give fitWithMeter's meter one size base, so the uncut figure needs no caller special case | ⬜ |
| [#117](https://github.com/breferrari/mindframe/issues/117) | Accept a newly followed import whose target another record keeps, when the target is present | ✅ |
| [#119](https://github.com/breferrari/mindframe/issues/119) | Read a BOM'd Gemini settings file as Gemini does: it doesn't parse, so it names nothing | ✅ |
| [#126](https://github.com/breferrari/mindframe/issues/126) | Give write hooks the payload's targets from the core, with removed files and one effect run per call | ⬜ |
| [#128](https://github.com/breferrari/mindframe/issues/128) | Build openVault's migration notes from what the registry did: none under the kill switch, one for a refused qmd module | ⬜ |
| [#133](https://github.com/breferrari/mindframe/issues/133) | Follow files a recorded file spawns by path in vendor update, as it follows imports | ⬜ |
| [#136](https://github.com/breferrari/mindframe/issues/136) | Let a vendor record track a file outside its source root, inside the upstream repo | ⬜ |

## Phase 3: first-party extensions

| Issue | What | Status |
|-------|------|--------|
| [#13](https://github.com/breferrari/mindframe/issues/13) | Ship qmd as an optional extension | 🔨 split into #69, #70, #71 |
| [#69](https://github.com/breferrari/mindframe/issues/69) | Let extensions run side effects, and add a pre-compact event | ✅ |
| [#70](https://github.com/breferrari/mindframe/issues/70) | Move qmd out of the core into an optional extension | ✅ |
| [#71](https://github.com/breferrari/mindframe/issues/71) | Ship the qmd MCP bridge with the qmd extension | ⏳ after #70 |
| [#94](https://github.com/breferrari/mindframe/issues/94) | Skip session-start's detached qmd refresh when VAULT_QMD_REFRESH=off, as obsidian-mind #338 does | ✅ |
| [#95](https://github.com/breferrari/mindframe/issues/95) | Run qmd's index refresh as the qmd extension's effects | ✅ |
| [#96](https://github.com/breferrari/mindframe/issues/96) | Move qmd's bootstrap and model setup into the qmd extension | ✅ |
| [#135](https://github.com/breferrari/mindframe/issues/135) | Remove the core's qmd re-exports once no vendored file outside the extension imports them | ⏳ after breferrari/wiki-mind#112 |
| [#101](https://github.com/breferrari/mindframe/issues/101) | Add the contract-spec row for effects (DESIGN rule 10) once a vault calls runEffects | ✅ |
| [#123](https://github.com/breferrari/mindframe/issues/123) | Find a global qmd where npm keeps it, without spawning npm root -g | ✅ |
| [#125](https://github.com/breferrari/mindframe/issues/125) | Name the qmd extension's refresh worker qmd-refresh-run, so obsidian-mind's leftover-worker guard sees it | ✅ |
| [#106](https://github.com/breferrari/mindframe/issues/106) | Run the qmd refresh worker from the temp folder, not the vault, so it never holds the vault open on Windows | ⬜ |
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

## Shelf: parked (one at a time, later)

Parked issues, taken one at a time. The milestone's `Shelf:` description keeps `next.sh` from taking them. A taken issue moves into a phase.

| Issue | What | Status |
|-------|------|--------|
| [#57](https://github.com/breferrari/mindframe/issues/57) | Let update fold a merge into a patch when later patches change the same file | ⬜ |
| [#59](https://github.com/breferrari/mindframe/issues/59) | Delete retired patches instead of keeping them in vendor-patches | ⬜ |
| [#65](https://github.com/breferrari/mindframe/issues/65) | Make the vendor guard's suggested commands work for a file in any record | ⬜ |
| [#66](https://github.com/breferrari/mindframe/issues/66) | Let patch new --issue say what is wrong, not only show the diff | ⬜ |
| [#92](https://github.com/breferrari/mindframe/issues/92) | Let a vault choose its instruction file | ⬜ |
| [#108](https://github.com/breferrari/mindframe/issues/108) | Write a new frontmatter block after a note's BOM: the write side of #82's reader | ⬜ |
