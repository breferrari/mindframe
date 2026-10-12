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
// `import x from "s"`, `export { x } from "s"`, `import "s"`, and `import("s")`.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/** Every module specifier a source names. */
export function specifiers(source: string): string[] {
	return [...source.matchAll(IMPORT)].flatMap(([, spec]) => (spec === undefined ? [] : [spec]));
}

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
		for (const spec of specifiers(readFileSync(file, "utf-8"))) {
			if (spec.startsWith("node:")) continue;
			const target = posix.normalize(posix.join(from, spec));
			const inside = !target.startsWith("..");
			assert.ok(inside || target === "../../core/index.ts", `${relative(HERE, file)} imports ${spec}`);
		}
	}
});

test("the rule reads every form of import, so none slips past it", () => {
	const source = [
		'import { a } from "./a.ts";',
		'import type { B } from "../../core/index.ts";',
		'export { c } from "./c.ts";',
		'export * from "./d.ts";',
		'import "../../lib/side-effect.ts";',
		'const m = await import("../../lib/dynamic.ts");',
		"const n = await import ( '../../lib/spaced.ts' );",
	].join("\n");
	assert.deepEqual(specifiers(source), ["./a.ts", "../../core/index.ts", "./c.ts", "./d.ts", "../../lib/side-effect.ts", "../../lib/dynamic.ts", "../../lib/spaced.ts"]);
});
