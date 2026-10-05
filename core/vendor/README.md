# Vendor record and drift check

A vault carries a copy of the core and its chosen extensions. `VENDOR.json` (default `.claude/VENDOR.json`) records where the copy came from, and this tool checks offline that the copy is still what the record says. Why: [DESIGN.md rule 11](../../docs/DESIGN.md#11-the-drift-check-vendored-bytes-match-the-recorded-commit).

```sh
node --experimental-strip-types core/vendor/cli.ts check  [--vault <dir>] [--record <path>]
node --experimental-strip-types core/vendor/cli.ts record --upstream <checkout> [--vault <dir>] [--record <path>]
     [--change <path>=<one line>]... [--set <key>=<value>]... [<path>...]
```

| Exit | `check` | `record` |
|------|---------|----------|
| 0 | every vendored file matches the record | the record was written |
| 1 | one line per problem, or the record can't be verified | refused: nothing written |
| 2 | usage error | usage error |

## The record

Schema 2 is a strict superset of schema 1, the shape ShardMind's vendored kits and wiki-mind already use. Every schema-1 field keeps its name and meaning: `repository`, `commit`, `tag`, `version`, `package`, `license`, `copyright`, an optional `sourceRoot`, and `files`. Each file is mapped to `upstream`, `modified` and, when modified, a one-line `change`. Schema 2 adds two hashes per file:

| Field | What |
|-------|------|
| `sha256` | the file's bytes as vendored |
| `upstreamSha256` | upstream's bytes at `commit` (under `sourceRoot` when set) |

`modified` is computed as `sha256 != upstreamSha256` and never typed by hand. The file is written with keys sorted at every depth, two-space JSON and a trailing newline, so re-recording produces no diff when nothing changed.

## What `check` reports

- a file whose bytes differ from `sha256`: edited without a record;
- a recorded file that is missing, or is (or passes through) a symlink;
- `modified` disagreeing with the two hashes;
- a modified file without a `change` line, or a `change` on an unmodified one;
- a schema-1 record: **unverifiable**, exit 1. It has no hashes, so nothing it says can be checked. Run `record` to upgrade it.

## Text and binary

A Windows checkout with `core.autocrlf=true` has CRLF line ends in its working tree, and a raw hash would call every file edited. So a **text** file is hashed with CRLF read as LF; a lone CR is kept, as git keeps it. A **binary** file is hashed raw. A file is binary when its first 8,000 bytes contain a NUL byte, the same test git uses.

## `record`

- The commit is the upstream checkout's `HEAD`. A checkout with uncommitted changes is refused.
- A path must be relative and inside the vault, and must not be or pass through a symlink, on both the vault side and the upstream side.
- With no paths, every path already in the record is re-recorded. With paths, the others are kept only if they already have hashes: a schema-1 entry left out is refused, so the result is always fully verifiable.
- A file that differs from upstream needs `--change <path>=<one line>`, unless the record already has its change.
- `--set` fills or changes metadata (`repository`, `tag`, `version`, …). A new record needs at least `--set repository=<url>`.
