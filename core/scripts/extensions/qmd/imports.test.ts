/**
 * The import rule for the qmd extension (#70): its code imports the core's
 * public entry point, its own files and Node, and nothing else of the core,
 * so the core can change its internals without breaking it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPORT = /^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm;

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return sources(path);
		return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path] : [];
	});
}

test("the extension's code imports only core/index.ts, its own files, and node:", () => {
	const files = sources(HERE);
	assert.ok(files.length >= 4, "index, session and the two libraries");
	for (const file of files) {
		const from = relative(HERE, dirname(file)).split(sep).join(posix.sep);
		for (const [, spec] of readFileSync(file, "utf-8").matchAll(IMPORT)) {
			if (spec === undefined || spec.startsWith("node:")) continue;
			const target = posix.normalize(posix.join(from, spec));
			const inside = !target.startsWith("..");
			assert.ok(inside || target === "../../core/index.ts", `${relative(HERE, file)} imports ${spec}`);
		}
	}
});
