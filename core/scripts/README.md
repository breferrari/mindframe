# The core, as a vault carries it

This folder mirrors a vault's `.claude/scripts/`:

| Here | In a vault | Holds |
|------|------------|-------|
| `core/` | `.claude/scripts/core/` | The extension registry (`registry.ts`), its API types (`types.ts`), the public entry point extensions import (`index.ts`), QMD's session-start work (`qmd-session.ts`), and their tests |
| `lib/` | `.claude/scripts/lib/` | The core's libraries: `hook-io` (hook I/O and the output cap), `session-start` (the byte budget and its meter), `project-dir` (vault-root discovery), `om-mod` (the mod's flag protocol), `frontmatter` (write validation: required fields, `shouldSkipFile`), `prose-width` (the no-hard-wrap rule), `qmd`, `wikilinks`, `regex` |
| `tests/` | `.claude/scripts/tests/` | The libraries' tests: `hook-io`, `project-dir`, `om-mod`, `frontmatter`, `prose-width`, `regex`, `wikilinks`. One frontmatter case is skipped: it checks a vault's own Work Note template against its manifest, which only obsidian-mind ships |

**Two contracts every vault shares, and that don't change:**
- `project-dir` finds the vault root by walking up from the project directory to the first folder holding `vault-manifest.json`, so a session started in a subfolder still finds its vault.
- `om-mod` reads the `om_mod` field a mod passes to a settings hook: `standdown` (the mod delivers this event: print nothing), `deliver` (print the context for the mod's instruction file) and `report` (return the Stop report as data).

The mod itself is still each vault's own; one template for every vault is [#47](https://github.com/breferrari/mindframe/issues/47).

**Entry points start from `core/context.ts`.** `openVault(vaultRoot, event)` reads and parses `vault-manifest.json` once and loads the registry for that event, so no entry point parses the manifest itself. `readManifest` never throws: a missing or malformed manifest means no extensions and the default budgets. `context.ts` is for entry points; extensions import only from `index.ts`.

A vault vendors this folder by copying it onto its `.claude/scripts/`, byte for byte, and records the copy in its `VENDOR.json`. The paths and imports (`../lib/x.ts`) are the same on both sides, so updating a vault's copy is a source swap, never a merge. Extensions import only from `core/index.ts` (DESIGN.md rule 2, and the import rule wiki-mind recorded for the lift). Library internals may be renamed or split without breaking them.

**`lib/session-start.ts` is not all core API.** It still carries three obsidian-mind formatters: `formatActiveWork`, `hasBrainContent` and `formatBrainIndex` (seam S2). They move out to obsidian-mind's own extensions when obsidian-mind adopts mindframe (Phase 4), not before, because splitting the file now would break the byte-identical copy vaults rely on. Don't build on them ([#46](https://github.com/breferrari/mindframe/issues/46)).

## Where it came from

The core was prototyped in wiki-mind and lifted here unmodified. [`VENDOR.json`](VENDOR.json) records that one-time move: every lifted file (the core, its libraries, and the libraries' tests) at wiki-mind `3ce7381`, under `.claude/scripts/`, with 0 files modified. `core/context.ts` is mindframe's own, written after the lift. It is history, not a live check. From the lift on, mindframe is the upstream: the core changes here, and vaults vendor it from here.
