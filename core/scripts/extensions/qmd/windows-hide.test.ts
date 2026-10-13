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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extensionSources } from "./test-fakes.ts";

const DIR = fileURLToPath(new URL(".", import.meta.url));

/** The text of each direct spawn call in `source`: from the name to its closing parenthesis. */
export function spawnCalls(text: string): string[] {
	// Comments mention spawn calls too (`spawnSync("qmd", ...)`); only code counts.
	// Strings are matched first and kept, so a `/*` inside one ("**/*.md") opens no comment.
	const source = text.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, string) => string ?? " ");
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

	test("a /* inside a string opens no comment, so the code after it is still scanned", () => {
		assert.deepEqual(spawnCalls('const glob = "**/*.md";\nspawnSync("x");\n/** a doc */'), ['spawnSync("x")']);
		assert.deepEqual(spawnCalls('// spawnSync("in a comment")\n/* spawnSync("too") */'), []);
	});

	test("every direct spawn in the extension's code passes windowsHide", () => {
		const missing = extensionSources(DIR).flatMap((path) => spawnCalls(readFileSync(path, "utf8")).filter((call) => !call.includes("windowsHide")).map((call) => `${path}: ${call.slice(0, 80)}`));
		assert.deepEqual(missing, []);
	});
});
