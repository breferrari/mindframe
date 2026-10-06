/**
 * What every entry point needs before it can dispatch: the vault's parsed
 * `vault-manifest.json` and the registry loaded for its event. Every entry
 * point used to read and parse the manifest itself, five times over
 * (wiki-mind SPEC §7.2); the core does it once here.
 *
 * `readManifest` never throws: a missing, unreadable or malformed manifest
 * is `null`, which means no extensions and the default budgets, exactly as
 * each entry point treated it before.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, parseManifest, type Registry } from "./registry.ts";
import type { HookContext, HookEvent } from "./types.ts";

export type Manifest = Readonly<Record<string, unknown>> | null;

/** The vault's manifest, parsed; null when there is none or it can't be read. */
export function readManifest(vaultRoot: string): Manifest {
	let json: string | null = null;
	try {
		json = readFileSync(join(vaultRoot, "vault-manifest.json"), "utf-8");
	} catch {
		/* no manifest: no extensions, default budgets */
	}
	return parseManifest(json);
}

/**
 * The manifest, the registry for `event`, and the context handed to every
 * extension call. The registry already isolates each extension's failures,
 * so this throws only on a fault in the core itself; an entry point that
 * must answer anyway wraps it, as session-start does.
 */
export async function openVault(
	vaultRoot: string,
	event: HookEvent,
	env: NodeJS.ProcessEnv = process.env,
	now: number = Date.now(),
): Promise<{ manifest: Manifest; registry: Registry; ctx: HookContext }> {
	const manifest = readManifest(vaultRoot);
	const registry = await loadRegistry(vaultRoot, manifest, event, env);
	return { manifest, registry, ctx: { vaultRoot, manifest, now } };
}
