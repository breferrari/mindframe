/**
 * The vault's `vault-manifest.json`, parsed once (#52). Every reader in the core
 * takes the result: session-start's budget and QMD readers, the registry, and
 * openVault, which hands it to every extension as `ctx.manifest`.
 */

/** A parsed manifest: the object, or null when it is absent, malformed, or not an object. */
export type ManifestObject = Readonly<Record<string, unknown>> | null;

/** `value`, and everything inside it, frozen. */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value as object)) deepFreeze(inner);
	}
	return value;
}

/**
 * The manifest source parsed, and deep-frozen: extensions receive this object,
 * and the core reads its budget from it afterwards, so no extension may change
 * what the core reads (DESIGN.md rules 7 and 8). Null when the manifest is
 * absent, malformed, or not an object.
 */
export function manifestOf(manifestJson: string | null): ManifestObject {
	if (manifestJson === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestJson);
	} catch {
		return null; // malformed manifest → treat as missing
	}
	return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? deepFreeze(parsed as Record<string, unknown>) : null;
}
