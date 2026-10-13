/**
 * Detect whether the current ESM module was invoked directly as a script
 * (rather than imported). Use to gate side-effecting `main()` calls so the
 * module stays importable from tests and other modules.
 *
 *     if (isMainModule(import.meta.url)) main();
 *
 * Equivalent of CommonJS's `require.main === module`. `fileURLToPath` strips
 * the `file://` prefix and URL-encoded segments so the comparison against
 * `process.argv[1]` (which is already an absolute resolved path) is
 * apples-to-apples on every platform.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(importMetaUrl: string): boolean {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	const self = fileURLToPath(importMetaUrl);
	if (self === entry) return true;
	// import.meta.url is the module's real path; argv[1] is the path as typed, which a
	// linked folder (macOS's /var → /private/var, a junction) makes differ (obsidian-mind#391).
	try {
		return realpathSync(self) === realpathSync(entry);
	} catch {
		return false;
	}
}
