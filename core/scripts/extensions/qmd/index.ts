/**
 * The qmd extension (#70, #95): QMD's session-start notes as two
 * load-bearing, priority-0 sections, the self-heal note and the
 * minimum-version note, and its index refresh as effects. A vault vendors it
 * to `.claude/scripts/extensions/qmd/` and declares it in
 * `vault-manifest.json` (the line is `QMD_DECLARATION` in core/context.ts).
 *
 * The sections only render notes: both read one run of QMD's probes per hook
 * (session.ts), so `disable` on a section hides its note and nothing else.
 * The refresh is two effects:
 * - `qmd-session-refresh`, at session start: a detached `qmd update`, or the
 *   bootstrap on a missing or near-empty store;
 * - `qmd-refresh`, on a note written, before a compaction and at Stop: the
 *   debounced update and embed (lib/refresh.ts, lifted from obsidian-mind),
 *   in a detached worker (refresh-run.ts).
 *
 * `VAULT_QMD=off` turns all of it off. `VAULT_QMD_REFRESH=off` stops every
 * detached refresh and leaves the notes. QMD's probes are synchronous, so no
 * time limit can cut them short, and the declaration sets none; the
 * registry starts every call before any limit, so they don't spend other
 * extensions' time.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Effect, Extension, HookContext, Section } from "../../core/index.ts";
import { resolveQmdIndexOf } from "./lib/index-name.ts";
import { shouldRefreshForPath, triggerDebouncedRefresh, workerArgsFor } from "./lib/refresh.ts";
import { qmdOff } from "./lib/switches.ts";
import { SELF_HEAL_HEADER, VERSION_HEADER, qmdNotesOf, qmdSessionRefreshOf, realDeps, type QmdDeps, type QmdNote } from "./session.ts";

export { SELF_HEAL_HEADER, VERSION_HEADER };

/** The debounce between two refreshes, as obsidian-mind's hooks set it. */
export const REFRESH_DEBOUNCE_MS = 30_000;

/** The detached worker the refresh effect spawns. */
export const WORKER_PATH = fileURLToPath(new URL("./refresh-run.ts", import.meta.url));

/**
 * The refresh's sentinel: `QMD_REFRESH_SENTINEL`, or the file obsidian-mind's
 * hooks use, `.claude/scripts/.qmd-refresh-sentinel`, read as they read it
 * (unset only when absent). A vault that still triggers obsidian-mind's copy
 * shares it, so the two debounce as one.
 */
export function sentinelPathFor(vaultRoot: string, env: QmdDeps["env"]): string {
	return env["QMD_REFRESH_SENTINEL"] ?? join(vaultRoot, ".claude", "scripts", ".qmd-refresh-sentinel");
}

/** Test seams for the refresh effect: where the worker is, and how it is spawned. */
export type RefreshSeams = {
	readonly workerPath?: string;
	readonly spawnWorker?: (workerPath: string, args: readonly string[]) => void;
};

/** The extension over `deps`, so tests never run a real QMD. */
export function qmdExtension(deps: QmdDeps = realDeps, seams: RefreshSeams = {}): Extension {
	// Per hook: the context is fixed for a hook run, and every call in it gets the same one.
	const entries = new WeakMap<HookContext, string | null>();
	const depsFor = (ctx: HookContext): QmdDeps => ({
		...deps,
		resolveEntry: () => {
			if (!entries.has(ctx)) entries.set(ctx, deps.resolveEntry());
			return entries.get(ctx) ?? null;
		},
	});
	const runs = new WeakMap<HookContext, { readonly notes: readonly QmdNote[] } | { readonly error: unknown }>();
	const notesOf = (ctx: HookContext): readonly QmdNote[] => {
		let outcome = runs.get(ctx);
		if (outcome === undefined) {
			try {
				outcome = { notes: qmdNotesOf(ctx.vaultRoot, ctx.manifest, depsFor(ctx)) };
			} catch (error) {
				outcome = { error };
			}
			runs.set(ctx, outcome);
		}
		if ("error" in outcome) throw outcome.error;
		return outcome.notes;
	};
	const section = (id: string, header: string): Section => ({
		id,
		header,
		priority: 0,
		render: (ctx) => notesOf(ctx).find((n) => n.header === header)?.body ?? null,
	});
	const sessionRefresh: Effect = {
		id: "qmd-session-refresh",
		on: ["session-start"],
		run: (_trigger, ctx) => {
			// The probes first, from the hook's one run: an ABI self-heal rebuilds the
			// binding qmd update loads, so the update must not start before it.
			try {
				notesOf(ctx);
			} catch {
				/* reported by the sections; the refresh still runs */
			}
			qmdSessionRefreshOf(ctx.vaultRoot, ctx.manifest, depsFor(ctx));
		},
	};
	const refresh: Effect = {
		id: "qmd-refresh",
		on: ["write", "pre-compact", "stop"],
		run: (trigger, ctx) => {
			if (qmdOff(deps.env)) return;
			if (trigger.event === "write" && !shouldRefreshForPath(trigger.target.relPath)) return;
			// Spawned by path, so `vendor update` never brings it in: say so, rather than stamp and spawn nothing.
			const workerPath = seams.workerPath ?? WORKER_PATH;
			if (!existsSync(workerPath)) throw new Error(`the refresh worker is missing: ${workerPath}`);
			const live = depsFor(ctx);
			triggerDebouncedRefresh({
				sentinelPath: sentinelPathFor(ctx.vaultRoot, deps.env),
				workerPath,
				debounceMs: REFRESH_DEBOUNCE_MS,
				logPrefix: `qmd-refresh (${trigger.event})`,
				workerArgs: workerArgsFor(ctx.vaultRoot, resolveQmdIndexOf(ctx.manifest, ctx.vaultRoot)),
				env: deps.env,
				qmdAvailable: () => live.resolveEntry() !== null,
				...(seams.spawnWorker === undefined ? {} : { spawnWorker: seams.spawnWorker }),
			});
		},
	};
	return {
		id: "qmd",
		sections: [section("qmd-self-heal", SELF_HEAL_HEADER), section("qmd-version", VERSION_HEADER)],
		effects: [sessionRefresh, refresh],
	};
}

export const extension = qmdExtension();
