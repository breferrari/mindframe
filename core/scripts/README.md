# The core, as a vault carries it

This folder mirrors a vault's `.claude/scripts/`:

| Here | In a vault | Holds |
|------|------------|-------|
| `core/` | `.claude/scripts/core/` | The extension registry (`registry.ts`), its API types (`types.ts`), the public entry point extensions import (`index.ts`), QMD's session-start work (`qmd-session.ts`), and their tests |
| `lib/` | `.claude/scripts/lib/` | The libraries the core imports: `hook-io` (hook I/O and the output cap), `session-start` (the byte budget and its meter), `qmd`, `wikilinks`, `regex` |

A vault vendors this folder by copying it onto its `.claude/scripts/`, byte for byte, and records the copy in its `VENDOR.json`. The paths and imports (`../lib/x.ts`) are the same on both sides, so updating a vault's copy is a source swap, never a merge. Extensions import only from `core/index.ts` (DESIGN.md rule 2, and the import rule wiki-mind recorded for the lift). Library internals may be renamed or split without breaking them.

**`lib/session-start.ts` is not all core API.** It still carries three obsidian-mind formatters: `formatActiveWork`, `hasBrainContent` and `formatBrainIndex` (seam S2). They move out to obsidian-mind's own extensions when obsidian-mind adopts mindframe (Phase 4), not before, because splitting the file now would break the byte-identical copy vaults rely on. Don't build on them.

## Where it came from

The core was prototyped in wiki-mind and lifted here unmodified. [`VENDOR.json`](VENDOR.json) records that one-time move: every file at wiki-mind `3ce7381`, under `.claude/scripts/`, with 0 files modified. It is history, not a live check. From the lift on, mindframe is the upstream: the core changes here, and vaults vendor it from here.
