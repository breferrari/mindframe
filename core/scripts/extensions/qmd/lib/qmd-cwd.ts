/**
 * Where a qmd call about a vault runs, and what it is told, so it can run
 * from the OS temp folder without holding the vault open on Windows (#106).
 * Each rule follows what @tobilu/qmd 2.5.3 reads against its cwd (read in
 * its dist: cli/qmd.js's index selection, collections.js's
 * findLocalConfigPath and getConfigDir, store.js's getDefaultDbPath).
 */

import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The project-local qmd config at or above `dir`, as qmd looks for it when no
 * `--index` is given (@tobilu/qmd 2.5.3's `findLocalConfigPath`, from its
 * cwd): `.qmd/index.yaml`, then `.qmd/index.yml`, walking up. Null when none.
 */
export function localQmdConfigAt(dir: string): string | null {
	for (let at = resolve(dir); ; at = dirname(at)) {
		for (const name of ["index.yaml", "index.yml"]) {
			const file = join(at, ".qmd", name);
			if (existsSync(file)) return file;
		}
		if (dirname(at) === at) return null;
	}
}

/**
 * The cwd for a qmd call about `vault`: the OS temp folder, so a long qmd
 * process never holds the vault open on Windows (#106). With an index name,
 * qmd reads nothing against its cwd but the variables `qmdPathsAgainst`
 * pins. Without one, it uses the first project-local config above its cwd,
 * which no flag can pass: the vault stays the cwd whenever the temp folder
 * would find a different one (the vault's own, or one in the user profile
 * the temp folder sits in on Windows). Both are walked as qmd walks its
 * `process.cwd()`: by the real path on POSIX, where the cwd is always
 * resolved, and as given on Windows, where it keeps a junction or `subst`
 * drive. A temp folder that doesn't exist keeps the vault.
 */
export function qmdCwdFor(vault: string, qmdIndex: string | null, temp: string = tmpdir(), platform: NodeJS.Platform = process.platform): string {
	if (!existsSync(temp)) return vault;
	if (qmdIndex !== null) return temp;
	const asCwd = (dir: string): string => (platform === "win32" ? dir : realOr(dir));
	return localQmdConfigAt(asCwd(temp)) === localQmdConfigAt(asCwd(vault)) ? temp : vault;
}

const realOr = (dir: string): string => {
	try {
		return realpathSync.native(dir);
	} catch {
		return dir;
	}
};

/**
 * `env` with the path variables qmd reads resolved against the vault:
 * INDEX_PATH, QMD_CONFIG_DIR, XDG_CONFIG_HOME and XDG_CACHE_HOME. qmd uses
 * them as given, against its cwd (2.5.3's `getDefaultDbPath` and
 * `getConfigDir`), so a qmd call from outside the vault gets them as the
 * vault would have read them; an absolute one is kept, and a Windows
 * root-relative one (`\idx`) takes the vault's drive. Empty ones are qmd's
 * unset and stay so.
 */
export function qmdPathsAgainst(vault: string, env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
	const pinned: Record<string, string | undefined> = { ...env };
	for (const key of ["INDEX_PATH", "QMD_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
		const value = env[key];
		if (value) pinned[key] = resolve(vault, value);
	}
	return pinned;
}
