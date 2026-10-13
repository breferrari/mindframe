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
	// Strings are matched first and blanked, so a `/*` inside one ("**/*.md") opens no comment and a
	// parenthesis inside one doesn't stretch a call.
	const source = text.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, string) => (string === undefined ? " " : '""'));
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

/** Whether a spawn call hides its window: `windowsHide: true`, not `false` or a condition. */
export const hidesWindow = (call: string): boolean => /windowsHide:\s*true\b/.test(call);

describe("the qmd extension hides every console window it could open (#96)", () => {
	test("only windowsHide: true hides a window", () => {
		assert.equal(hidesWindow("spawnSync(x, { windowsHide: true })"), true);
		assert.equal(hidesWindow("spawnSync(x, { windowsHide: false })"), false);
		assert.equal(hidesWindow("spawnSync(x, { windowsHide: isWindows })"), false);
	});

	test("the scan finds a call and reads its options", () => {
		assert.deepEqual(spawnCalls('spawnSync("x", ["a"], { shell: true, windowsHide: true });\ndeps.spawnSync(a, b);'), ['spawnSync("", [""], { shell: true, windowsHide: true })']);
	});

	test("a /* inside a string opens no comment, so the code after it is still scanned", () => {
		assert.deepEqual(spawnCalls('const glob = "**/*.md";\nspawnSync("x");\n/** a doc */'), ['spawnSync("")']);
		assert.deepEqual(spawnCalls('spawnSync(cmd, ["(*.md"], { shell });\nspawnSync(x, { windowsHide: true });'), ['spawnSync(cmd, [""], { shell })', 'spawnSync(x, { windowsHide: true })'], "a paren in a string doesn't stretch a call");
		assert.deepEqual(spawnCalls('// spawnSync("in a comment")\n/* spawnSync("too") */'), []);
	});

	test("every direct spawn in the extension's code passes windowsHide", () => {
		const missing = extensionSources(DIR).flatMap((path) => spawnCalls(readFileSync(path, "utf8")).filter((call) => !hidesWindow(call)).map((call) => `${path}: ${call.slice(0, 80)}`));
		assert.deepEqual(missing, []);
	});
});
