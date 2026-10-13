/**
 * Every process the qmd extension starts hides its console window on Windows
 * (#96). A detached, console-less process (the bootstrap, the refresh worker)
 * that starts a console program without `windowsHide` gives that program a
 * console window of its own: one window per qmd call at every session start
 * that bootstraps. A real spawn's options can't be seen from a test, so this
 * reads the extension's source: each direct call to spawn or spawnSync passes
 * windowsHide. A call through an injected `deps` is the seam's, whose real
 * implementation is checked the same way.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-fakes.ts" ? [path] : [];
	});
}

/** The text of each direct spawn call in `source`: from the name to its closing parenthesis. */
export function spawnCalls(text: string): string[] {
	// Comments mention spawn calls too (`spawnSync("qmd", ...)`); only code counts.
	const source = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
	const calls: string[] = [];
	for (const m of source.matchAll(/(?<![.\w])(?:node)?(?:spawn|spawnSync|Spawn|SpawnSync)\(/g)) {
		let depth = 0;
		let end = m.index!;
		for (let i = m.index! + m[0].length - 1; i < source.length; i++) {
			if (source[i] === "(") depth++;
			else if (source[i] === ")" && --depth === 0) {
				end = i + 1;
				break;
			}
		}
		calls.push(source.slice(m.index!, end));
	}
	return calls;
}

describe("the qmd extension hides every console window it could open (#96)", () => {
	test("the scan finds a call and reads its options", () => {
		assert.deepEqual(spawnCalls('spawnSync("x", ["a"], { shell: true, windowsHide: true });\ndeps.spawnSync(a, b);'), ['spawnSync("x", ["a"], { shell: true, windowsHide: true })']);
	});

	test("every direct spawn in the extension's code passes windowsHide", () => {
		const missing = sources(DIR).flatMap((path) => spawnCalls(readFileSync(path, "utf8")).filter((call) => !call.includes("windowsHide")).map((call) => `${path}: ${call.slice(0, 80)}`));
		assert.deepEqual(missing, []);
	});
});
