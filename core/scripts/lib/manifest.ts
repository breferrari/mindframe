/**
 * The vault's `vault-manifest.json`, parsed once (#52). Every reader in the core
 * takes the result: session-start's budget and QMD readers, the registry, and
 * openVault, which hands it to every extension as `ctx.manifest`.
 */

/** A parsed manifest: the object, or null when it is absent, malformed, or not an object. */
export type ManifestObject = Readonly<Record<string, unknown>> | null;

/**
 * The manifest source parsed, unfrozen: the object, or null when it is absent,
 * malformed, or not an object. registry.ts's parseManifest, kept for vaults
 * that call it and may fill the result in.
 */
export function parseManifestJson(manifestJson: string | null): Record<string, unknown> | null {
	if (manifestJson === null) return null;
	try {
		const parsed: unknown = JSON.parse(manifestJson);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null; // malformed manifest → treat as missing
	}
}

/** `value` and everything inside it frozen, without recursion, so no depth of nesting overflows the stack. */
function deepFreeze<T>(value: T): T {
	const pending: unknown[] = [value];
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (next === null || typeof next !== "object") continue;
		Object.freeze(next);
		for (const inner of Object.values(next as object)) if (inner !== null && typeof inner === "object") pending.push(inner);
	}
	return value;
}

/**
 * The manifest source parsed and deep-frozen: the object extensions receive,
 * which the core reads its budget from afterwards, so no extension may change
 * what the core reads (DESIGN.md rules 7 and 8). Null when the manifest is
 * absent, malformed, or not an object. Never throws, however deep the nesting.
 */
export function manifestOf(manifestJson: string | null): ManifestObject {
	const parsed = parseManifestJson(manifestJson);
	return parsed === null ? null : deepFreeze(parsed);
}
