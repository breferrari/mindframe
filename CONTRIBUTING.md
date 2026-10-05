# Contributing

How to work on the mindframe repo. What mindframe is and how it is laid out: [README.md](README.md). The build order: `ROADMAP.md`.

## Workflow

- Branch and PR for every change. Never push to `main`.
- PR titles use `type: short description`. Types: `feat`, `fix`, `docs`, `chore`, `ci`, `test`, `refactor`. CI checks the format.
- One issue per PR, based on `main`. No stacked PRs. Update the issue's roadmap row in the same PR.
- Add or remove a top-level path only together with the README's layout section.

## Hard rules

1. **No agent-session artifacts in anything that lands in the repo.** That covers files, commit messages, PR and issue bodies, and review comments. Never include claude.ai session URLs, `Claude-Session:` trailers, or local absolute paths (`C:\...`, `/Users/...`, `/home/...`). Use repo-relative paths or GitHub URLs. `Co-Authored-By:` trailers are fine. CI greps tracked files for these.
2. **No commercial reasoning in the repo.** No competitor names, market positioning, naming rationale or launch plans. Design rationale is welcome: say why the design is what it is, not why the project is worth building.
3. **Branch and PR for everything**, as above.
4. **Windows, macOS and Linux are all supported.**
   - Build paths with path APIs, never by joining strings with `/` or `\`. Compare repo-relative paths in POSIX form.
   - Line endings are pinned to LF by `.gitattributes`. Vaults vendor these files and compare them by bytes, so a CRLF conversion is a defect, not a cosmetic diff.
   - Scripts are Node, not shell, unless a step only ever runs in CI.
   - CI runs on ubuntu, macOS and Windows. A change is green only when all three are.

## Tests

- Run them with `npm test` from the repo root (Node 22).
- **Show every new test can fail.** Mutate the code it guards (flip the condition, drop the guard), run that test alone, see it fail, then restore. A test that passes under the mutation is fixed, not kept.
- **Tests write only to temp directories.** Every state file a hook writes has an env override; test helpers set all of them. CI fails a run that leaves anything in the working tree, ignored files included.

## The test bed

`testbed/` runs hooks and the mod in real Claude Code sessions. Its rules:

- **Beds hold infrastructure only.** A bed copies a vault's `.claude/`, agent configs and `vault-manifest.json`, plus fixtures the expectation spec writes. Never a vault's notes. Turns and fixtures in this repo are neutral and written for it.
- **A run leaves nothing on the machine.** Each session's qmd store and config go to the run's output folder. Anything that still lands in the user's qmd folders is reported as a leak and fails the grade. Leaks are reported, never deleted.
- **Raw run output stays outside the repo.** Debug logs and transcripts carry local paths and session ids; they go to a temp directory by default. Summaries that land in a PR are written by hand from them, scrubbed of both.
- **Model-behaviour runs use Opus.** A smaller model is fine only where the model's answer is not what is measured.
- **Nothing deletes by variable path.** The bed builder refuses a folder that already exists; pick a new name.
- **Real sessions never run in CI by default.** They cost money and need a login. CI runs the test bed's own tests against synthetic transcripts.
