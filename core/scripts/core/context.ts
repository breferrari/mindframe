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
import { manifestOf, type ManifestObject } from "../lib/manifest.ts";
import { EXTENSIONS_KEY, loadRegistry, parseDeclarations, type Registry } from "./registry.ts";
import type { HookContext, HookEvent } from "./types.ts";

/** The name openVault has always returned; the same type as ManifestObject. */
export type Manifest = ManifestObject;

/** The vault's manifest, parsed; null when there is none or it can't be read. */
export function readManifest(vaultRoot: string): Manifest {
	let json: string | null = null;
	try {
		json = readFileSync(join(vaultRoot, "vault-manifest.json"), "utf-8");
	} catch {
		/* no manifest: no extensions, default budgets */
	}
	return manifestOf(json);
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

/** The events the qmd extension runs on: its sections at session start, and its refresh effects (#95). */
const QMD_EVENTS = ["session-start", "write", "pre-compact", "stop"] as const;

/** The declaration a vault adds to `extensions` to keep QMD's session-start work and its refresh (#70, #95). */
export const QMD_DECLARATION = JSON.stringify({ id: "qmd", module: ".claude/scripts/extensions/qmd/index.ts", events: QMD_EVENTS });

/**
 * Notes for the meter line about a step a vault still has to take after a
 * core update. QMD's session-start work left the core for the qmd extension
 * (#70): a manifest that sets `qmd_index` or `qmd_min_version` (an empty
 * `qmd_index` too: it means derive the name) and declares no extension with
 * id `qmd` would otherwise lose it without a trace. A declaration with
 * `enabled: false` counts: the vault chose that. One the registry refuses,
 * or one that doesn't list all four of its events (QMD_EVENTS), doesn't:
 * some of QMD's work would never run. The note is short, because it rides on the meter line, in the room
 * the budget keeps for it (METER_HEADROOM).
 *
 * The keys are the ones the extension reads (`qmdIndexOf` and
 * `qmdMinVersionOf` in extensions/qmd/lib/index-name.ts), read wider here:
 * any string sets a key.
 */
export function migrationNotes(manifest: Manifest): string[] {
	const setsQmd = typeof manifest?.["qmd_index"] === "string" || typeof manifest?.["qmd_min_version"] === "string";
	if (!setsQmd) return [];
	const accepted = parseDeclarations(manifest).result.filter((d) => d.id === "qmd");
	if (accepted.some((d) => d.enabled === false || QMD_EVENTS.every((e) => d.events.includes(e)))) return [];
	// Partly: an accepted entry that runs at session start, so the notes show, but misses a refresh event.
	if (accepted.some((d) => d.events.includes("session-start"))) return [`QMD: fix qmd entry to ${QMD_DECLARATION}`];
	const declared = manifest?.[EXTENSIONS_KEY];
	const named = Array.isArray(declared) && declared.some((d: unknown) => typeof d === "object" && d !== null && (d as Record<string, unknown>)["id"] === "qmd");
	return [`QMD off: ${named ? "fix qmd entry to" : "extensions needs"} ${QMD_DECLARATION}`];
}
