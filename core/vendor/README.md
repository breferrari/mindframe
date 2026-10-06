# Vendor record, patches and check

A vault carries a copy of the core and its chosen extensions, and the copy is upstream plus patches, nothing else. `VENDOR.json` (default `.claude/VENDOR.json`) records where the copy came from. A local change exists only as a patch in `vendor-patches/` beside the record. This tool checks offline that the copy is exactly upstream plus those patches, and that every patch says where it went upstream. Why: [DESIGN.md rule 11](../../docs/DESIGN.md#11-a-vendored-file-is-upstream-plus-patches-and-every-patch-goes-upstream).

```sh
node --experimental-strip-types core/vendor/cli.ts check   [--vault <dir>] [--record <path>]
node --experimental-strip-types core/vendor/cli.ts record  --upstream <checkout> [--vault <dir>] [--record <path>] [--set <key>=<value>]... [<path>...]
node --experimental-strip-types core/vendor/cli.ts migrate --upstream <checkout> [--vault <dir>] [--record <path>]
node --experimental-strip-types core/vendor/cli.ts patch new <slug> <file>... --upstream <checkout> --description "<the change to make>" \n     (--forward <url> | --issue | --not-needed "<reason>")
node --experimental-strip-types core/vendor/cli.ts patch upstream <NNNN-slug.patch> --upstream <checkout> [--pr] [--base <branch>]
node --experimental-strip-types core/vendor/cli.ts update  --upstream <checkout> [--vault <dir>] [--record <path>] [--resolved <file>]...
```

| Exit | `check` | `record`, `migrate`, `patch`, `update` |
|------|---------|---------------------|
| 0 | every vendored file is upstream plus its patches, and every patch is forwarded | written |
| 1 | one line per problem, or a record that can't be verified | refused: nothing written (`update` with a conflict writes only the markers) |
| 2 | usage error | usage error |

## The record (schema 3)

Every schema-1 and schema-2 field keeps its name and meaning: `repository`, `commit`, `tag`, `version`, `package`, `license`, `copyright`, an optional `sourceRoot`, and `files`. Each file maps to:

| Field | What |
|-------|------|
| `upstream` | its path upstream (under `sourceRoot` when set) |
| `sha256` | the file's bytes as vendored |
| `upstreamSha256` | upstream's bytes at `commit` |
| `patches` | the patch files that turn upstream into the vendored bytes, in apply order; absent when the file is upstream as is |

Schema 2's `modified` and `change` are gone: a change is a patch. The file is written with keys sorted at every depth, two-space JSON and a trailing newline, so re-recording produces no diff when nothing changed.

## Patches

`vendor-patches/NNNN-slug.patch`, next to the record, with paths relative to the record's root. One logical fix per patch, written by the tool, never by hand: a short header, a blank line, then a git-style unified diff over LF text.

```
Description: give the budget meter a trailing newline
Forwarded: https://github.com/breferrari/mindframe/issues/123
Last-Update: 2026-10-06

diff --git a/lib/hook-io.ts b/lib/hook-io.ts
--- a/lib/hook-io.ts
+++ b/lib/hook-io.ts
@@ -10,3 +10,3 @@
…
```

| Header | |
|--------|---|
| `Description` | required: what the patch changes |
| `Forwarded` | required: the upstream issue or PR URL, or `not-needed: <reason>` |
| `Origin`, `Last-Update` | optional |
| `Applied-Upstream` | written only by the tool, when upstream has absorbed the patch and it retires. A retired patch may stay in the folder as history, unlisted |

## What `check` reports

- an edit without a patch (bytes differ from `sha256`);
- patches that don't lead back to upstream: each patch is undone exactly, last first, with no fuzz, and the result must hash to `upstreamSha256`;
- a file that differs from upstream and lists no patch;
- a patch that is missing, unreadable, or listed by no file (an orphan), or that changes a file which doesn't list it;
- a patch without `Description`, or with a `Forwarded` that is empty or neither a URL nor `not-needed: <reason>`;
- a retired patch still listed;
- a recorded file that is missing, or is (or passes through) a symlink;
- a schema-1 record (unverifiable: no hashes) or a schema-2 record (run `migrate`).

There is no pending state and no date check: whether a patch passes depends on its text alone, so the check gives the same answer on every machine and every day.

## Text and binary

A Windows checkout with `core.autocrlf=true` has CRLF line ends in its working tree. So text is hashed and patched with CRLF read as LF, and a lone CR is kept, as git keeps it. A **binary** file is hashed raw and can't carry patches. A file is binary when its first 8,000 bytes contain a NUL byte, the same test git uses.

## `record`

- The commit is the upstream checkout's `HEAD`. A checkout with uncommitted changes is refused.
- A path must be relative and inside the vault, and must not be or pass through a symlink, on both the vault side and the upstream side.
- With no paths, every path already in the record is re-recorded. With paths, the others are kept only if they already have hashes.
- A file that differs from upstream must already list patches that lead exactly back to it. Otherwise it is refused: make the change a patch with `vendor patch new`.
- `--set` fills or changes metadata (`repository`, `tag`, `version`, …). A new record needs at least `--set repository=<url>`.

## `migrate`

Converts a schema-2 record, from an upstream checkout at the record's commit. Each `modified` file becomes one patch: the diff from upstream to the vault's bytes, with the old `change` line as `Description` and `Forwarded` left empty. `check` fails until every `Forwarded` is filled, so each local change gets an upstream answer the day the vault migrates. Patch numbers continue after any already in the folder.

## `patch new`

Edit the vendored file, then make the edit a patch:

```sh
node --experimental-strip-types core/vendor/cli.ts patch new fix-meter-newline .claude/scripts/lib/hook-io.ts   --upstream <mindframe checkout at the record's commit> --description "Give the meter a trailing newline" --issue
```

- It needs exactly one upstream answer. `--forward <url>` takes an existing issue or PR. `--issue` files one with `gh`; the `Description` becomes the issue title, so write it as the change to make. `--not-needed "<reason>"` says why the change stays local.
- Each file's change is measured from upstream plus the patches it already carries, so a new patch stacks on the old ones and holds only its own change.
- The `Description` must read as the change to make: one starting with "The " or "It ", or ending with a full stop, is refused. Before anything goes to `gh`, the issue body and the diff are scanned for local absolute paths and session artifacts, and a hit is refused with the offending line.
- Everything is checked before anything is filed upstream, and nothing is written if filing fails.
- The patch gets the next number in `vendor-patches/`, and the record lists it and takes the file's new hash.
- It refuses a file that isn't in the record, a binary file, an edit-free file, and an upstream checkout that isn't at the record's commit.

## `patch upstream`

```sh
node --experimental-strip-types core/vendor/cli.ts patch upstream 0003-fix-meter-newline.patch --upstream <mindframe checkout> --pr
```

It applies the patch on a new branch, `vendor-patch/NNNN-slug`, in the upstream checkout and commits it with the `Description` as the message. With `--pr` it then:
- pushes the branch;
- opens a pull request titled `fix: <description>`; when `Forwarded` was an issue, the body closes it;
- writes the PR's URL into `Forwarded`, keeping the issue as `Origin`.

A patch that no longer applies to the checkout is refused before any branch is made.

## `update`

```sh
node --experimental-strip-types core/vendor/cli.ts update --upstream <mindframe checkout at the new commit>
```

It moves the copy to the checkout's commit, file by file:
- an unpatched file takes the new upstream as it is, and a binary file is copied raw;
- a patch that still applies is kept and re-anchored. Its lines may have moved, but its context must match exactly; there is no fuzz;
- a patch whose change upstream already has retires: it gains `Applied-Upstream: <commit>` and leaves the record, but stays in `vendor-patches/` as history;
- otherwise the old upstream, the vault and the new upstream are merged three ways. A clean merge folds into the patch. A conflict writes markers into that file and nothing else, and exits 1 with the record still at the old commit. Resolve the markers, then run `update` again with `--resolved <file>`, and the result folds into the patch.

It refuses an edit without a patch, a file that's gone upstream, a file whose patches don't lead back to its upstream, and a schema 1 or 2 record (run `migrate` first). Folding a merge into a patch would empty any later patch on the same file, so that case is refused too: combine those patches into one with `patch new`, then update.
