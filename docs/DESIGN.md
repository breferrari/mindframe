# Design

Why mindframe's core is shaped the way it is. The rules below are the contract the core keeps with every extension and every vault. The extension registry is prototyped in [wiki-mind](https://github.com/breferrari/wiki-mind) first and lifted here once it has passed real sessions (see `ROADMAP.md`, Phase 2). Each rule names the failure it prevents.

## The extension contract

### 1. One in-process dispatcher per event

Each lifecycle event (session start, prompt submit, write, pre-compact, Stop) has one entry point. That entry point loads the registered extensions and calls them in-process, in one Node process.

**Why:** a process per extension multiplies startup cost on every event, and hooks have tight timeouts. One dispatcher is also the only place that can see every extension's output at once, and rules 5 and 7 depend on that.

### 2. Vendored paths and vault paths are disjoint

The core and first-party extensions live under paths the vault never edits. A vault's own extensions live under `.claude/extensions/`, which a vendor update never touches.

**Why:** if a vault's code and vendored code share files, every update becomes a merge. When the paths are disjoint, an update replaces vendored files outright and can't lose a vault's work. Rule 11 checks that the vendored side stays unedited.

### 3. Extensions are declared up front in `vault-manifest.json`

The dispatcher runs only the extensions the manifest names. It never discovers them by scanning folders.

**Why:** a declaration is reviewable. A diff to the manifest shows what will run in every session. Scanning would run whatever file landed in a folder, including a half-written one or a leftover from an old version.

### 4. Ordering: numeric priority, unset last, ties broken by id

Each extension may set a numeric priority. Priority 0 is the most important. A larger number means lower priority: it runs later, and under the budget (rule 7) it is cut first. Extensions without a priority are the lowest of all, and equal priorities sort by extension id.

**Why:** order decides what the model reads first, and which sections survive the budget (rule 7). It has to be the same on every machine and every run. Load order, file-system order and object-key order all vary, but a sort on (priority, id) does not.

### 5. Each extension runs isolated: try/catch and a timeout, failing open, reported

The dispatcher wraps every extension call with an exception handler and a per-extension timeout. An extension that throws or runs out of time is skipped, and the rest of the event goes on. The hook still succeeds, and its output names the extension that failed and why.

**Why:** a hook that fails delivers nothing, so one broken extension would silence every other one. Failing open protects the rest. Reporting the failure keeps it from going unnoticed: a skipped extension that left no trace would look exactly like an extension with nothing to say.

### 6. One kill switch

One environment variable turns off every extension for a session. The core's own behaviour keeps running.

**Why:** when a session misbehaves, the first question is whether an extension is the cause. One switch answers it without editing the manifest, and it works the same on every vault.

### 7. The core owns the output budget; extensions return sections, never stdout

An extension returns structured sections (a title, a body, a priority). It never writes to stdout itself. The core assembles the sections in order and fits them to the event's byte budget. The lowest-priority sections, those with the largest numbers and then those with none (rule 4), are shortened or dropped first, and a meter line records what was cut.

**Why:** hook output that reaches the model has hard size limits. Past them, the platform may cut the output silently to a preview while still reporting success. If extensions printed their own output, no single place could enforce the limit, and the cut would land wherever the bytes ran out, often in the middle of the most important section. When the core owns the budget, the cut is deliberate, follows priority, and is visible in the meter.

### 8. Extensions can't weaken core guards

Guards the core runs (pre-tool guards, write validation the core requires) run before or after the extensions, outside their reach. An extension can add a finding or a block. It can't remove one the core produced or downgrade it.

**Why:** a vault adds extensions for its own needs. A guard that any extension could switch off protects nothing.

### 9. Override by merging named slots, disable by id, never replace files

To change first-party behaviour, a vault overrides named slots (a setting, a section title, a threshold) through the manifest, or disables an extension by id. It never edits or shadows a vendored file.

**Why:** a replaced file stops receiving updates and fixes without anyone noticing. Slot overrides survive an update because the update reads them; an edited file doesn't, because the update overwrites it, or rule 11 refuses it.

### 10. Failure is observable in a real session

Every rule above is checked in real Claude Code sessions by the test bed, not only by unit tests: ordering, budget degradation, and a throwing extension being reported and skipped while the hook still succeeds.

**Why:** a hook can pass every unit test, run, report success, and still deliver nothing useful, because the platform cut its output. The only proof is a session in which the model is asked what arrived.

## Vendoring

### 11. A vendored file is upstream plus patches, and every patch goes upstream

A vault vendors the core and its chosen extensions, with a `VENDOR.json` recording the repository, the commit, and every vendored path. For each path the record stores the hash of the bytes as vendored, the hash of upstream's bytes at the recorded commit, and the patches that turn one into the other. A vendored file is never edited in place: a local change exists only as a patch in `vendor-patches/` beside the record, written by the tool, one logical fix per patch.

Each patch carries a short header: `Description`, which says what it changes, and `Forwarded`, which says where the change went upstream, as an issue or PR URL, or `not-needed: <reason>`. A patch can't be made without one of the three: `vendor patch new` files the upstream issue or takes the URL or the reason as it writes the patch.

The check is offline and needs no copy of upstream. For each vendored file it reads the vault's bytes, undoes each patch exactly, last first, with no fuzz, and requires the result to hash to the recorded upstream hash. It fails on:
- an edit without a patch;
- patches that don't lead back to upstream;
- a patch file that is missing, or that nothing lists;
- a patch without `Description`, or with a `Forwarded` that is neither a URL nor `not-needed: <reason>`;
- a recorded file that is missing or replaced by a symlink.

A record without hashes can't be verified, so it fails too; it never passes by default. A record from before patches existed fails until `vendor migrate` turns each changed file into a patch, whose `Forwarded` has to be filled before the check passes. There is no pending state and no date: whether a patch passes depends on its text alone.

Text is read with CRLF as LF, so a Windows checkout that converts line ends neither reads as an edit nor breaks a patch. Binary files, those with a NUL byte in their first 8,000 bytes, are hashed raw and can't carry patches.

A vault runs the check in CI, where it is the guarantee; a write hook that stops edits to vendored files is only a prompt. The tool and the record format are in [`core/vendor/`](../core/vendor/README.md).

**Why:** rule 2 keeps vendored and vault code apart by convention, and this rule enforces it. A change made downstream, by a person or by an agent mid-task, is the fix the upstream never gets: it ships, works, and disappears at the next update, or it lives on as a private fork of shared code. Making every local change a patch keeps it visible and re-appliable. Requiring an upstream answer before the check passes means a fix can't stay downstream by default. Checking by undoing the patches needs no network, no git, and no copy of upstream in the vault.
