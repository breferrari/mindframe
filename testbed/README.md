# Test bed

Runs a vault's hooks and its mod in real Claude Code sessions, and records what each hook did on each turn. Unit tests prove a hook's logic; only a real session shows what Claude Code ran, what it delivered, and what the user saw. The runner works with any vault: the vault folder and its spec are inputs.

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
node testbed/bin/bed.mjs build --vault <vault-dir> --spec <spec.json> --bed <new-dir>
```

- `run` builds a fresh bed for every scenario and arm, drives one session in it, and writes `results.json`. It prints a summary per run.
- `show` prints that summary again from a `results.json`.
- `build` makes one bed and stops, for looking around or running a hook by hand.

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
| `mod.dir`, `mod.name` | The mod folder inside the bed, and its plugin name (default: the folder name). Needed for the mod arm |
| `session.model` | Default `opus`. Use a smaller model only where the model's answers are not what is measured |
| `session.maxBudgetUsd` | Per-session cap, default 4 |
| `session.allowedTools` | Tools the scripted turns may use without a prompt |
| `session.gapMs`, `settleMs`, `turnTimeoutMs` | The pause after a result before the next turn (2 s); the wait after the last result for late events (5 s); the longest a turn may take (180 s) |
| `session.env` | Extra environment for the session, such as a hook's state-path override |
| `scenarios[].arms` | Default both |
| `scenarios[].turns` | A string, or `{ text, before }`. `before` actions run in the bed just before the turn is sent: `{ "append": path, "bytes": n, "char": "y" }` or `{ "write": path, "content": "..." }` |

All paths are relative POSIX paths inside the bed. The runner refuses `..`, absolute paths and backslashes.

Per-turn expectations and the grader that checks them are added by [#4](https://github.com/breferrari/mindframe/issues/4).

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
