/**
 * The qmd extension (#70): QMD's session-start work as two load-bearing,
 * priority-0 sections, the self-heal note and the minimum-version note. A
 * vault vendors it to `.claude/scripts/extensions/qmd/` and declares it in
 * `vault-manifest.json` (the line is `QMD_DECLARATION` in core/context.ts).
 *
 * Both sections read one run of QMD's work per hook (session.ts), which also
 * starts the background index refresh, as the core did before. Moving that
 * refresh to an effect is #95. So `disable` on a section hides its note and
 * leaves the work running: `enabled: false` or `VAULT_QMD=off` turns it off.
 *
 * The work is synchronous (spawnSync probes), so the declaration's
 * `timeoutMs` can't cut it short; it keeps the limit honest for when it
 * isn't. The registry starts each call's limit when the call starts, so
 * this run doesn't spend other extensions' time.
 */

import type { Extension, HookContext, Section } from "../../core/index.ts";
import { SELF_HEAL_HEADER, VERSION_HEADER, qmdSessionStartOf, realDeps, type QmdDeps, type QmdSessionResult } from "./session.ts";

export { SELF_HEAL_HEADER, VERSION_HEADER };

/** The extension over `deps`, so tests never run a real QMD. */
export function qmdExtension(deps: QmdDeps = realDeps): Extension {
	// One run per hook: the context is fixed for a hook run, and both sections get the same one.
	const runs = new WeakMap<HookContext, { readonly result: QmdSessionResult } | { readonly error: unknown }>();
	const run = (ctx: HookContext): QmdSessionResult => {
		let outcome = runs.get(ctx);
		if (outcome === undefined) {
			try {
				outcome = { result: qmdSessionStartOf(ctx.vaultRoot, ctx.manifest, undefined, deps) };
			} catch (error) {
				outcome = { error };
			}
			runs.set(ctx, outcome);
		}
		if ("error" in outcome) throw outcome.error;
		return outcome.result;
	};
	const section = (id: string, header: string): Section => ({
		id,
		header,
		priority: 0,
		render: (ctx) => run(ctx).notes.find((n) => n.header === header)?.body ?? null,
	});
	return { id: "qmd", sections: [section("qmd-self-heal", SELF_HEAL_HEADER), section("qmd-version", VERSION_HEADER)] };
}

export const extension = qmdExtension();
