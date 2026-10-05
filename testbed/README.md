# Test bed

Runs a vault's hooks and its mod in real Claude Code sessions, records what each hook did on each turn, and grades the runs against what the vault's spec says should happen. Unit tests prove a hook's logic; only a real session shows what Claude Code ran, what it delivered, and what the user saw. The runner works with any vault: the vault folder and its spec are inputs.

Every session runs on one of two **arms**:

| Arm | What loads | What it proves |
|-----|------------|----------------|
| `settings` | the bed's `.claude/settings.json` hooks only | the plain hook path: older Claude Code, a mod that failed to load, other agents that run the same scripts |
| `mod` | the settings hooks, plus the vault's mod through `--plugin-dir` | the mod path on Claude Code 2.1.287 and later |

A run is **valid** only if it tested the arm it claims. The session's `init` event must list the mod and the debug log must show `hooks module <mod>@… loaded` on the mod arm, and neither may appear on the settings arm. An invalid run's hook results describe the other arm, so the runner marks it and exits 1.

## Running it

```sh
node testbed/bin/bed.mjs run --vault <vault-dir> --spec <spec.json> [--arm settings|mod] [--scenario <id>]... [--out <dir>] [--claude <bin>]
node testbed/bin/bed.mjs show <out-dir>/results.json
node testbed/bin/bed.mjs compare main=<out-a>/results.json branch=<out-b>/results.json
node testbed/bin/bed.mjs dry --vault <vault-dir> --spec <spec.json> [--scenario <id>]... [--out <dir>]
node testbed/bin/bed.mjs build --vault <vault-dir> --spec <spec.json> --bed <new-dir>
```

- `run` builds a fresh bed for every scenario and arm, drives one session in it, and writes `results.json`. It prints a summary per run.
- `show` prints that summary again from a `results.json`.
- `dry` checks a spec's log layer before a live run spends anything. For each scenario it builds a bed and runs the vault's own hook scripts directly, in the order a session would: SessionStart at startup, then per turn UserPromptSubmit, PreCompact and SessionStart (compact) for a `/compact` turn, a Write plus PostToolUse when the turn asks to create a file, and Stop. It covers the settings arm only, and grades only what the hooks printed. Answers, what the user is shown, judged rows and mod events are left out, and answer and tool measures record nothing. The scripts are the om_mod contract's entry-point names (`session-start.ts`, `classify-message.ts`, `validate-write.ts`, `pre-compact.ts`, `stop-checklist.ts`).
- A scenario can set its own `allowedTools` and `disallowedTools`, replacing the session's. `disallowedTools` removes tools from the session entirely, so a measure reads only what the hooks delivered.
- `build` makes one bed and stops, for looking around. To run a hook by hand, use `dry` instead: it gives the hook the same environment and residue check as a session.

**Output stays outside the repo.** By default `run` writes to `<os temp>/mindframe-testbed/<spec>-<timestamp>/`. Debug logs and transcripts carry local paths and session ids. `--out` overrides the location; the folder must not exist yet.

```
<out>/
  results.json        every run: arm check, per-turn hooks, answers, mod timings
  beds/<scenario>-<arm>/
  logs/<scenario>-<arm>.jsonl     the session's stream-json output
  logs/<scenario>-<arm>.debug     Claude Code's debug log
  logs/<scenario>-<arm>.err
  logs/<scenario>-<arm>.feed.json when each turn was sent
```

**Cost.** Each session is a real model session, capped by `session.maxBudgetUsd`. On Windows every session briefly opens console windows that take focus. Nothing here runs in CI. CI runs `npm test`, which drives the runner against a stand-in for `claude` (`tests/fixtures/fake-claude.mjs`).

## The bed

A bed is a new folder holding:

- the vault's **infrastructure**: `bed.include` (default `.claude`, `.codex`, `.gemini`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `vault-manifest.json`, `.gitignore`). Tracked and untracked files are both copied, so uncommitted work is tested; ignored files are not. A vault's notes are never copied. A public template vault may set `include: ["."]` to copy its whole tree;
- `bed.copy`: folders copied as they are, such as a scripts folder's `node_modules`;
- `bed.fixtures`: files the spec writes, such as a drifted note for a hygiene check, or an oversized one;
- a git repo with one commit, because several hook sections read git state.

The builder refuses a folder that exists and never deletes anything.

## The spec

```json
{
  "name": "my-vault",
  "bed": {
    "copy": [".claude/scripts/node_modules"],
    "fixtures": [
      { "path": "work/active/Done.md", "content": "---\nstatus: completed\n---\n# Done\n" },
      { "path": "notes/Big.md", "header": "---\ndate: 2026-01-01\n---\n", "fill": 26000 }
    ]
  },
  "mod": { "dir": ".claude/skills/my-mod", "name": "my-mod" },
  "session": { "model": "opus", "maxBudgetUsd": 4, "allowedTools": ["Edit"] },
  "scenarios": [
    {
      "id": "stop-report",
      "arms": ["settings", "mod"],
      "turns": [
        "Say only: one.",
        { "text": "Say only: two.", "before": [{ "append": "notes/Big.md", "bytes": 3000 }] }
      ]
    }
  ]
}
```

| Key | Meaning |
|-----|---------|
| `name` | Lowercase id; names the output folder |
| `bed.include`, `bed.copy`, `bed.fixtures` | See [The bed](#the-bed). A fixture has `content`, or `fill` bytes of `char` (default `x`) after an optional `header` |
| `bed.files` | `[{ from, path }]`: files copied from the repo into the bed. `from` is relative to the spec file, so a spec can use fixtures beside it |
| `bed.manifest` | `{ set, extensions }`: edits the bed's `vault-manifest.json`. `set` replaces top-level keys (never `extensions`); `extensions` appends declarations after the vault's own |
| `mod.dir`, `mod.name` | The mod folder inside the bed, and its plugin name (default: the folder name). Needed for the mod arm |
| `session.model` | Default `opus`. Use a smaller model only where the model's answers are not what is measured |
| `session.maxBudgetUsd` | Per-session cap, default 4 |
| `session.allowedTools` | Tools the scripted turns may use without a prompt |
| `session.gapMs`, `settleMs`, `turnTimeoutMs` | The pause after a result before the next turn (2 s); the wait after the last result for late events (5 s); the longest a turn may take (180 s) |
| `session.env` | Extra environment for the session, such as a hook's state-path override |
| `scenarios[].arms` | Default both |
| `scenarios[].allowedTools`, `scenarios[].disallowedTools` | Replace `session.allowedTools` and `session.disallowedTools` for this scenario. `disallowedTools` takes tools away from the model entirely (`--disallowedTools`) |
| `scenarios[].env` | Merged over `session.env` for this scenario, such as a kill switch |
| `scenarios[].files` | Like `bed.files`, for this scenario's bed only, copied after them. Two scenarios can then differ in one file and share everything else |
| `scenarios[].measures` | What to record rather than grade; see [Measures](#measures) |
| `scenarios[].turns` | A string, or `{ text, before }`. `before` actions run in the bed just before the turn is sent: `{ "append": path, "bytes": n, "char": "y" }` or `{ "write": path, "content": "..." }` |

All paths are relative POSIX paths inside the bed. The runner refuses `..`, absolute paths and backslashes.

## Expectations

Write the expected behaviour before the run: if you can't say what each turn must do, you don't yet know what you are testing. Each scenario carries an `expect` list:

```json
"expect": [
  { "id": "Stop reports drift", "arms": ["settings"], "turn": 1, "hook": { "event": "Stop", "output": "Wrap-up checklist" } },
  { "id": "report reaches the agent", "turn": 2, "answer": { "not": { "none": true } } },
  { "id": "report delivered once", "turn": 3, "answer": { "none": true } }
]
```

Every expectation has an `id`, unique in its scenario, and exactly one kind. `arms` defaults to the scenario's arms. `turn` is a 1-based turn number, `"preamble"` (hooks before the first prompt), `"any"` (passes if any one turn passes) or `"all"` (passes only if every turn does; the first that fails is named). For `hook`, `"any"` and `"all"` include the preamble. For a `hook` on `"all"`, every run of that hook across the session is checked together. `silent: true` is refused on `"any"`, because one silent turn says nothing about the others: write `"all"`.

There are two layers. A log shows that a hook ran, not what reached the model. So any claim that something was delivered is made on the model layer: a turn asks the model, and the expectation reads its answer.

| Kind | Layer | Passes when |
|------|-------|-------------|
| `hook: { event, name?, ran?, exit?, silent?, output?, everyOutput? }` | log | Hooks of that event (and name) ran in the turn and every one exited 0, or exited with `exit` where one is given. `silent: true`: every one printed nothing or `{}`; `silent: false`: at least one printed something. `output`: at least one output matches; `everyOutput`: every output does, which a negative such as `{ "not": "MF-" }` needs. `ran: false`: none ran |
| `answer: <matcher>` | model | The model's answer in the turn matches |
| `shown: <matcher>` | log | What the user was shown (a Stop `systemMessage`, a mod's line under the answer) matches |
| `tools: { includes?, max? }` | log | The turn called these tools, and no more than `max` calls in all |
| `modEvent: { event, min?, maxMs? }` | log | The mod's handler for `event` settled at least `min` times (default 1) in the run, none slower than `maxMs`. Mod arm only |
| `order: { in, items }` | either | Every item is present in the source, in this order. Presence is checked first, so a missing item fails rather than sorting first |
| `budget: { in, maxBytes?, lastLine?, present?, absent? }` | either | The source is non-empty and at most `maxBytes` bytes (UTF-8, exact). Its last line matches `lastLine`, so a meter line that arrived proves nothing was cut. `present` sections survived and `absent` ones were dropped |
| `meter: { in, maxBytes?, collapsed?, sections? }` | either | The last line is a session-start meter (`_context injected: X.XkB / Y.YkB budget — collapsed: A, B_`), not truncated, and its claims are true. The size it reports fits its budget and `maxBytes`. The bytes that arrived fit `maxBytes`, and are no fewer than it reports (±50 bytes of rounding). Its collapsed list equals `collapsed`. Each of `sections` (`{ name, body }`) is named as collapsed exactly when its body is missing. Leave `sections` out when which sections get cut isn't the point. The meter may also carry `degraded: X (level)`, for a section cut below full but above its pointer |
| `isolates: { event, extension, present? }` | log | The hook still exited 0, its output names the extension that failed, and the other sections (`present`) are still there |
| `judge: { question, rubric }` | model | A blind model grader decides (see below). Needs a numbered turn |

`in` (the source) is `answer`, `shown`, or `hook:<Event>` (the outputs of that event's hooks in the turn).

**Matchers.** A string means "includes". Objects:
- `{ "re": "...", "flags": "i" }`, `{ "equals": "..." }`, `{ "includes": "..." }`;
- `{ "none": true }`, met when the answer is NONE (allowing for a period, quotes, backticks or bold);
- `{ "not": m }`, `{ "all": [...] }`, `{ "any": [...] }`.

Ask the model a question it can answer NONE to ("Did X arrive with THIS message? If not, reply only: NONE"), and ask it on consecutive turns. The first must quote the report and the next must say NONE, which shows the report was delivered once.

## Measures

An A/B needs numbers, not verdicts: how many of 30 goals a session named, whether it read a file, how far a section was cut. A scenario's `measures` are recorded per run beside the grade, never change its outcome, and get a table of their own in `results.md`.

| Kind | Records |
|------|---------|
| `count: { in, markers }` | how many distinct markers the source names (case-insensitive), as `n/total` |
| `toolRead: { path }` | whether any tool call's file, path, pattern or command names the path, and which tool |
| `meterLevel: { in, section }` | the section's level in the session-start meter: `full` when the meter names it nowhere, the level in parentheses under `degraded:` or `collapsed:`, and `pointer` for a bare name under `collapsed:` |
| `meterSlack: { in }` | the budget the meter says went unused: its budget minus the size it reports |
| `bytes: { in }` | the source's size in bytes |

Each takes `turn` (default `"any"`) and `arms`. A measure on an invalid run or a missing turn records nothing (`—`), never zero.

Tool calls are recorded with only what they touched (a file, path, pattern, command or URL, cut to 300 characters), so a transcript's file contents never land in `results.json`.

**Comparing runs.** Run one spec against two vaults, say a branch and main, then put them side by side:

```sh
node testbed/bin/bed.mjs compare main=<out-a>/results.json ladder=<out-b>/results.json
```

This prints one table per scenario: a row per measure plus each run's expectation tally, with a column per label and arm. The results must come from the same spec.

## Grading

`run` grades as it finishes. It writes `grades.json` and `results.md` next to `results.json`. A grade has one of three outcomes:

| Outcome | When | Exit |
|---------|------|------|
| pass | every expectation passed and every run was valid | 0 |
| fail | an expectation failed, or a run was invalid | 1 |
| incomplete | nothing failed, but `judge` rows await the blind grader | 3 |

Incomplete is never a pass: a grade that skipped what it couldn't check hasn't passed (DESIGN.md rule 10). Exit 2 is a usage error. `results.md` holds:
- the verdict;
- a table of expectations by arm, with the reason for each failure;
- a table of every hook by arm: times run, failures, silent runs;
- the mod's events with their slowest time.

`bed.mjs grade <results.json>` grades again. The spec travels inside `results.json`, so nothing else is needed.

**The blind grader**, for questions a pattern can't settle ("did the answer apply the user's own rule?"):

1. `bed.mjs judge prepare <results.json>` collects every `judge` answer, shuffles them and removes scenario and arm. It writes `judge-prompt.md`, plus a key the grader never sees.
2. Give `judge-prompt.md` to one tool-less model call, and save its JSON array.
3. `bed.mjs judge apply <results.json> <verdicts.json>` maps the verdicts back and grades again. A missing, duplicated or unknown verdict refuses the whole set.

Until verdicts are applied, `judge` rows show as awaiting and the grade is incomplete.

## Specs in this repo

| Spec | Vault | Covers |
|------|-------|--------|
| [`specs/obsidian-mind.json`](specs/obsidian-mind.json) | obsidian-mind v9.0.1 | **Settings arm:** all five settings hooks (SessionStart, UserPromptSubmit, PostToolUse, PreCompact, Stop). **Mod arm:** SessionStart and Stop delivery, with the settings hooks standing down. **Model layer:** the context's meter line at startup (both arms) and after `/compact` (mod arm), and a Stop report delivered once, then again after the findings change |

| [`specs/wiki-mind.json`](specs/wiki-mind.json) | wiki-mind | Its own extension, on both arms and across a compaction (settings: the counts stay whole and the other sections become pointers; mod: the full context survives). **Sections:** in priority order, with the counts, the open question, the newest source and the head of `Index.md`; the meter last with nothing collapsed; the model receives the counts. **Detectors:** a summary of three drifts (unsourced concept, one-sided synthesis, unannotated note), the full report with the next prompt and only once, and the counts rising after a new note. **Signals:** a URL routes to `/wiki-ingest`. **Validators:** §2 frontmatter and the source-link rule. **Mod arm:** the settings hooks stand down every turn, the mod delivers, and its `wiki-mind: vault check:` line shows under the answer. Runs with `VAULT_QMD=off` |
| [`specs/north-star-ab.json`](specs/north-star-ab.json) | obsidian-mind, run against two versions and compared | Whether a session knows the vault's goals when the North Star is too long for the hook budget (obsidian-mind#304). Two synthetic North Stars from [`fixtures/north-star/`](fixtures/north-star/): 30 live bullets of 380 bytes, and the size profile of a real vault that fails (12 live goals, median 626 bytes, plus 3 completed). On both arms it measures goal markers named (out of 30 or 12), whether the session read `brain/North Star.md`, the levels of North Star, the listing and the brain index in the meter, unused budget and bytes delivered. It expects the meter to be last and true |
| [`specs/contract.json`](specs/contract.json) | any vault that implements the extension contract (today: wiki-mind) | `docs/DESIGN.md` rules 3–7, on both arms. **Rule 3:** an extension declared for session-start is never loaded at prompt, write or Stop. **Rule 4:** item, declaration and unset priorities, and ties by id, as the hook printed them (settings arm) and as the model received them (both arms, through the mod's instruction file on the mod arm). **Rule 7:** the meter's numbers and collapses checked against what arrived. **Rule 5:** a throw, a rejection, a never-settling call, a wrong shape and a throwing getter, each reported while the hook succeeds and the witness extension's items arrive. **Rule 6:** the kill switch, including through the mod |

Their turns and fixtures are neutral and were written for this repo. `contract.json`'s extensions are in [`fixtures/contract/`](fixtures/contract/).

## What a run must not leave behind

A bed vault with QMD writes an index store and a collection config named after the bed folder. Left alone, both land in the user's own qmd folders, `~/.cache/qmd` and `~/.config/qmd`, and stay there after the run. So each session runs with:

| Variable | Set to | qmd's default |
|----------|--------|---------------|
| `INDEX_PATH` | `<out>/state/<scenario>-<arm>/qmd/index.sqlite` | `($XDG_CACHE_HOME or ~/.cache)/qmd/<index>.sqlite` |
| `QMD_CONFIG_DIR` | `<out>/state/<scenario>-<arm>/qmd/config` | `($XDG_CONFIG_HOME or ~/.config)/qmd` |

The embedding models (`<cache>/qmd/models`) stay shared, because they are large. A spec's `session.env` or a scenario's `env` can still override either variable.

Code that ignores those variables, such as a hard-coded config path, would still write to the user's folders. So the runner lists both folders before and after each session:
- an entry the session created is a **leak**, and so is a changed entry named after the bed;
- a leak is recorded on the run, listed at the top of `results.md`, and fails the grade;
- a change to any other entry is only noted (`residue.touched`), because the user's own sessions write to their stores while a bed runs.

The runner never deletes anything, leaks included.

A dry run gets exactly the same treatment. Every hook it spawns gets its environment from the same builder as a live session (`bedEnv`), and the same before and after snapshot. Hand-run hooks get neither, which is why `dry` exists.

## How turns are paced

Each turn is sent only after the previous turn's `result`, then `gapMs` later. Sent all at once, stream-json input folds several prompts into one turn, and a per-turn expectation stops meaning anything. A mod may add turns of its own (a plugin-submitted prompt); those produce extra results and don't block the feed.

## What is recorded, and from where

Formats as written by Claude Code 2.1.289. The parsers are `lib/stream.mjs` and `lib/debug.mjs`, and their fixtures are `tests/fixtures/*-2.1.289.*`. If a later version changes a format, the fixtures and parsers change together.

| Fact | Source |
|------|--------|
| Each settings hook per turn: event, name, exit code, outcome, output | stream: `system/hook_started`, `system/hook_response` (`--include-hook-events`) |
| A hook that started and never responded | stream: a `hook_started` with no matching `hook_response` (status `started`) |
| The turn's prompt, answer and tool calls | stream: replayed `user` (`--replay-user-messages`), `assistant` |
| What the user was shown (a Stop `systemMessage`, a mod's line under the answer) | stream: `system/informational` |
| Hooks that ran before the first prompt (SessionStart) | stream, kept as the run's `preamble` |
| Version, model, loaded plugins | stream: `system/init` |
| Whether the mod loaded, and its per-event time | debug log: `hooks module <id> loaded (…)`, `hooks module <id> <event> settled in <n>ms` |

A log shows that a hook ran, not what reached the model. Delivery claims are proved by asking the model in a turn; #4's expectations do that.
