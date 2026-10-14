/**
 * Test-only. A QMD that isn't there: the side effects of session.ts,
 * recorded, for the extension's tests. Nothing here runs QMD or touches a QMD store.
 */
import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMPTY_STORE_BYTES, type QmdDeps } from "./session.ts";

export const VAULT = join("/", "vaults", "My Wiki");

export type Calls = { sync: string[]; detached: { cmd: string; args: readonly string[]; cwd: string }[] };

export function fakeDeps(opts: {
	entry?: string | null;
	status?: { status: number; stderr: string };
	version?: string;
	rebuild?: number;
	storeBytes?: number | null;
	env?: Record<string, string>;
	exists?: (path: string) => boolean;
}): { deps: QmdDeps; calls: Calls } {
	const calls: Calls = { sync: [], detached: [] };
	const deps: QmdDeps = {
		env: opts.env ?? {},
		resolveEntry: () => (opts.entry === undefined ? join("/", "npm", "@tobilu", "qmd", "dist", "cli", "qmd.js") : opts.entry),
		spawnSync: (cmd, args) => {
			const line = [cmd, ...args].join(" ");
			calls.sync.push(line);
			if (line.includes("npm rebuild")) return { status: opts.rebuild ?? 0 };
			if (line.includes("--version")) return { status: 0, stdout: opts.version ?? "qmd 2.1.0\n" };
			return opts.status ?? { status: 0, stderr: "" };
		},
		spawnDetached: (cmd, args, o) => void calls.detached.push({ cmd, args, cwd: o.cwd }),
		storeSize: () => (opts.storeBytes === undefined ? EMPTY_STORE_BYTES * 10 : opts.storeBytes),
		home: join("/", "home", "u"),
		exists: opts.exists ?? (() => true),
	};
	return { deps, calls };
}

/** Remove a temp tree; a tree Windows still holds open is left, not thrown over. */
export function rmTemp(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		/* left for the OS's temp cleanup */
	}
}

/** Poll until `condition` holds or `timeoutMs` passes. */
export async function waitFor(condition: () => boolean, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

/** A host path from a literal, as obsidian-mind's test helpers make one: resolved on this OS. */
export function hostPath(literal: string): string {
	return resolve(literal);
}

/** The extension's code under `dir`: every .ts file but the tests and these fakes, which the scan tests read. */
export function extensionSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return extensionSources(path);
		return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && e.name !== "test-fakes.ts" ? [path] : [];
	});
}

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
