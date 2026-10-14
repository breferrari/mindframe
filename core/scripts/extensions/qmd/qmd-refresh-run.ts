#!/usr/bin/env node
/**
 * Detached worker for the mid-session QMD refresh. Spawned by the qmd
 * extension's refresh effect (write, pre-compact and Stop) as a
 * backgrounded child so the hook itself returns in milliseconds.
 *
 * Runs `qmd update` (BM25/FTS) followed by `qmd embed` (vector index)
 * so mid-session writes become searchable through every retrieval arm,
 * not just keyword search. Each step's timeout travels on the
 * invocation tuple from `composeWorkerInvocations`, so reordering the
 * pipeline can never silently swap timeouts onto the wrong step.
 *
 * Never writes to stdout/stderr. Never exits non-zero in a way the
 * user sees, since both parents `stdio: 'ignore'` the child. qmd
 * failures are swallowed deliberately: QMD is optional infrastructure,
 * and a flaky refresh must not pollute the next session's context or
 * terminal.
 *
 * Its vault and index come from its arguments (`--vault`, `--index`), which
 * the qmd extension's refresh effect resolves exactly as session start does
 * (lifted from obsidian-mind 0a58edf's `qmd-refresh-run.ts`, #95, which
 * derived them from its own path two folders below the vault; this one sits
 * four deep). No `--vault`: nothing to refresh, so it exits. Its qmd steps
 * run from the OS temp folder, not the vault, so a worker that lasts
 * minutes doesn't hold the vault open on Windows (#106), unless qmd would
 * find a different project-local config from there (`qmdCwdFor`).
 *
 * Multi-platform: delegates the spawn shape to `lib/qmd.ts`, which
 * routes through `process.execPath qmd.js` on every OS, bypassing the
 * .cmd shim on Windows.
 */

import { spawnSync } from "node:child_process";
import { debug } from "../../core/index.ts";
import { resolveQmdEntry } from "./lib/qmd.ts";
import { qmdCwdFor, qmdPathsAgainst } from "./lib/qmd-cwd.ts";
import { claimTrailingFlush, composeWorkerInvocations, parseWorkerArgs } from "./lib/refresh.ts";

const { trailing, vault, index } = parseWorkerArgs(process.argv.slice(2));
if (vault === null) {
	debug("qmd-refresh-run: no --vault; nothing to refresh");
	process.exit(0);
}

// Trailing flush: a trigger landed inside the debounce window, so this
// worker sleeps out the rest of it, then runs unless a newer refresh has
// already started (that refresh covers the same writes).
if (trailing !== null) {
	await new Promise((r) => setTimeout(r, trailing.delayMs));
	if (!claimTrailingFlush(trailing.sentinelPath, trailing.afterMs)) {
		debug("qmd-refresh-run: trailing flush superseded by a newer refresh");
		process.exit(0);
	}
}

const invocations = composeWorkerInvocations(index, resolveQmdEntry());
// The temp folder unless qmd would find a different local config from there (#106).
const cwd = qmdCwdFor(vault, index);
const env = qmdPathsAgainst(vault, process.env);

for (const inv of invocations) {
	const result = spawnSync(inv.cmd, inv.args as string[], {
		stdio: "ignore",
		timeout: inv.timeoutMs,
		shell: inv.shell,
		windowsHide: true,
		cwd,
		env,
	});
	if (result.error) {
		debug(`qmd-refresh-run: ${inv.args.join(" ")} — ${result.error.message}`);
	}
}
