/**
 * A QMD that isn't there: the side effects of session.ts, recorded, for the
 * extension's tests. Nothing here runs QMD or touches a QMD store.
 */
import { join } from "node:path";
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
	};
	return { deps, calls };
}
