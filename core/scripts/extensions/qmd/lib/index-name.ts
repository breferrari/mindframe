/**
 * qmd's index name, version floor and store path, read from the manifest
 * and the environment. Moved here from the core's lib/session-start.ts
 * (#70), which re-exports them until #135.
 */

import { basename, join, resolve } from "node:path";
import type { ManifestObject } from "../../../core/index.ts";

/**
 * Restricted character set for `qmd_index`. The value ends up in both CLI
 * argv and a filesystem path (`~/.cache/qmd/<name>.sqlite`), so path
 * separators, parent-dir refs, whitespace, and shell metacharacters must
 * not be accepted. Mirrors the shape of npm package names / git branch
 * segments: alnum + dot + dash + underscore, must start with an alnum.
 */
const QMD_INDEX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * True when `value` is a string that's safe to use as a qmd named index.
 * Exported so callers that read the manifest from other surfaces (the MCP
 * wrapper, the bootstrap script) can apply the same rule.
 */
export function isValidQmdIndex(value: unknown): value is string {
	return typeof value === "string" && QMD_INDEX_PATTERN.test(value);
}

/** `qmd_index`, when it is a valid index name; null otherwise (parseQmdIndex on the parsed manifest). */
export function qmdIndexOf(manifest: ManifestObject): string | null {
	const value = manifest?.["qmd_index"];
	return isValidQmdIndex(value) ? value : null;
}

/**
 * Derive a qmd index name from the vault's own directory name.
 *
 * The shipped manifest leaves `qmd_index` empty because the template is one
 * package installed many times — any literal it ships is identical in every
 * vault, so two vaults on one machine share a single SQLite store, search
 * bleeds across them, and re-indexing one clobbers the other (#137). The
 * install location is the only per-vault identity available without asking
 * the user a question, and it exists on both install paths.
 *
 * The slug rules mirror ShardMind's `slugifyVaultName` (shardmind#143)
 * deliberately: if a future engine-side substitution ever bakes the name in,
 * it resolves to the same string this derives, so the two mechanisms cannot
 * disagree about which store a vault owns.
 *
 * Returns null when the folder name has no usable characters (e.g. a purely
 * non-Latin name), so the caller falls back rather than emitting a broken
 * index name.
 */
export function deriveQmdIndex(vaultRoot: string): string | null {
	const slug = basename(resolve(vaultRoot))
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^a-z0-9]+|[-._]+$/g, "");
	return isValidQmdIndex(slug) ? slug : null;
}

/**
 * Extract a validated `template` name from a manifest source — the shared
 * package identity, and the last-resort index name when a vault has neither
 * a pin nor a derivable folder slug.
 */
function templateNameOf(manifest: ManifestObject): string | null {
	const value = manifest?.["template"];
	return isValidQmdIndex(value) ? value : null;
}

/** resolveQmdIndex on the parsed manifest. */
export function resolveQmdIndexOf(manifest: ManifestObject, vaultRoot: string): string | null {
	return qmdIndexOf(manifest) ?? deriveQmdIndex(vaultRoot) ?? templateNameOf(manifest);
}

/**
 * Build the argv tail for a `qmd` CLI invocation, prepending `--index <name>`
 * when the vault has configured a named index. Callers pass the subcommand
 * and its args (e.g. `["update"]`, `["query", text, "--json"]`); the return
 * value is the full argv after the `qmd` command itself.
 */
export function qmdArgsWithIndex(
	index: string | null,
	subcommandArgs: readonly string[],
): string[] {
	return index === null
		? [...subcommandArgs]
		: ["--index", index, ...subcommandArgs];
}

/**
 * True when a captured stderr blob is @tobilu/qmd's native `better-sqlite3`
 * binding failing to load because it was compiled against a different Node
 * ABI than the one currently running (`ERR_DLOPEN_FAILED` / a
 * `NODE_MODULE_VERSION` mismatch message). This is a DISTINCT failure mode
 * from "store missing/empty" (see `qmdStoreLooksEmpty` in the hook script):
 * the sqlite file can be tens of MB and perfectly healthy, but every qmd
 * invocation still crashes before it ever opens it, because the native
 * addon itself won't load under the current Node binary — typically after
 * a Node upgrade on the host machine. Query results and the whole MCP
 * server go silently dark in this state (the fire-and-forget re-index spawn
 * swallows the crash), so this check exists to catch it instead of letting
 * a session quietly fall back to Grep/Read for the rest of its life.
 */
export function isQmdNativeAbiMismatch(stderr: string): boolean {
	return (
		stderr.includes("NODE_MODULE_VERSION") ||
		stderr.includes("ERR_DLOPEN_FAILED")
	);
}

/**
 * Derive the @tobilu/qmd package root (the directory containing its
 * package.json) from `resolveQmdEntry()`'s resolved entry path
 * (`.../@tobilu/qmd/dist/cli/qmd.js`), so a native-module rebuild can run
 * `npm rebuild` with that directory as its cwd — portable across a global
 * npm install, a local one, Homebrew's node_modules layout, or Windows,
 * without hardcoding any machine-specific prefix path. Returns null when
 * the entry itself is null (no resolvable install to rebuild) or doesn't
 * match the expected `dist/cli/qmd.js` shape.
 */
export function qmdPackageRootFromEntry(entry: string | null): string | null {
	if (entry === null) return null;
	const marker = join("dist", "cli", "qmd.js");
	if (!entry.endsWith(marker)) return null;
	const prefixLen = entry.length - marker.length - 1; // -1 drops the separator before "dist"
	return prefixLen > 0 ? entry.slice(0, prefixLen) : null;
}

/** `qmd_min_version`, when it is a non-empty string; null otherwise. */
export function qmdMinVersionOf(manifest: ManifestObject): string | null {
	const value = manifest?.["qmd_min_version"];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The sqlite store qmd will open for a named index, resolved exactly as
 * @tobilu/qmd's own `getDefaultDbPath()` (store.js) does:
 * 1. `INDEX_PATH`, when set, for every index name;
 * 2. else `$XDG_CACHE_HOME/qmd/<name>.sqlite`, when non-empty;
 * 3. else `<home>/.cache/qmd/<name>.sqlite`, with home taken as qmd's
 *    `qmdHomedir()` takes it: `HOME`, then `USERPROFILE`, then `home`.
 * Empty values count as unset, as qmd's `||` reads them. Without step 1 the
 * store-size check behind bootstrap-vs-update looked at a file qmd never
 * opens whenever INDEX_PATH was set. The MCP wrapper's
 * resolveIndexSqlitePath (qmd-mcp.mjs) mirrors steps 2–3. Pure: env and home
 * are injected for testability.
 */
export function resolveIndexStorePath(
	indexName: string,
	env: Record<string, string | undefined>,
	home: string,
): string {
	if (env["INDEX_PATH"]) return env["INDEX_PATH"];
	const base = env["XDG_CACHE_HOME"] || join(env["HOME"] || env["USERPROFILE"] || home, ".cache");
	return join(base, "qmd", `${indexName}.sqlite`);
}
