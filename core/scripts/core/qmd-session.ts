/**
 * QMD's session-start work, as core code any vault's session-start runs
 * (SPEC.md §7.2, seam S5). Lift candidate: obsidian-mind keeps this logic
 * inside its session-start entry point; here it is a function over the
 * vendored QMD libraries, so the extracted core gives it to every vault.
 *
 * Gated on an installed QMD: a machine without one gets no probes, no
 * spawn, no notes. With one:
 * - ABI self-heal: if QMD's native SQLite binding is compiled against the
 *   wrong Node ABI, every QMD call crashes and search goes dark in silence.
 *   A timeboxed status probe detects it, and `npm rebuild better-sqlite3`
 *   fixes it. A note says which happened.
 * - Minimum version: below `qmd_min_version`, a warning note. A session is
 *   never broken by an old QMD.
 * - Index refresh: a detached `qmd update` on this vault's index, or the
 *   idempotent bootstrap when the store is missing or implausibly small (a
 *   clean clone has no registered collection, and `update` would no-op).
 *
 * `VAULT_QMD=off` turns all of it off: tests set it so a session-start run
 * never reaches the QMD index store in the user's cache.
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { statSync as nodeStatSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { buildQmdCommand, qmdVersionAtLeast, resolveQmdEntry } from "../lib/qmd.ts";
import {
	isQmdNativeAbiMismatch,
	parseQmdMinVersion,
	qmdArgsWithIndex,
	qmdPackageRootFromEntry,
	resolveIndexStorePath,
	resolveQmdIndex,
} from "../lib/session-start.ts";

/** A store below this size holds no indexed notes: bootstrap rather than update. */
export const EMPTY_STORE_BYTES = 500_000;

/** The environment variable that turns QMD's session-start work off. */
export const QMD_SWITCH = "VAULT_QMD";

type SpawnSyncResult = { readonly status: number | null; readonly stdout?: string; readonly stderr?: string };

/** The side effects, injectable so tests never run a real QMD. */
export type QmdDeps = {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly resolveEntry: () => string | null;
	readonly spawnSync: (cmd: string, args: readonly string[], opts: { cwd?: string; timeout: number; shell: boolean }) => SpawnSyncResult;
	readonly spawnDetached: (cmd: string, args: readonly string[], opts: { cwd: string; shell: boolean }) => void;
	readonly storeSize: (path: string) => number | null;
	readonly home: string;
};

export const realDeps: QmdDeps = {
	env: process.env,
	resolveEntry: resolveQmdEntry,
	spawnSync: (cmd, args, opts) => nodeSpawnSync(cmd, args as string[], { ...opts, encoding: "utf-8", windowsHide: true }),
	spawnDetached: (cmd, args, opts) => {
		const child = nodeSpawn(cmd, args as string[], { ...opts, stdio: "ignore", detached: true, windowsHide: true });
		// QMD is optional: a failed spawn must not crash the hook.
		child.on("error", () => undefined);
		child.unref();
	},
	storeSize: (path) => {
		try {
			return nodeStatSync(path).size;
		} catch {
			return null;
		}
	},
	home: homedir(),
};

export type QmdSessionResult = {
	/** Load-bearing notes for the session context, as heading and body. */
	readonly notes: readonly { readonly header: string; readonly body: string }[];
	/** What was started in the background: "update", "bootstrap", or nothing. */
	readonly refresh: "update" | "bootstrap" | null;
};

/**
 * QMD's session-start work for the vault at `vaultRoot`. `bootstrapScript`
 * is the vault-relative bootstrap path (run with the vault as cwd).
 */
export function qmdSessionStart(
	vaultRoot: string,
	manifestJson: string | null,
	bootstrapScript = ".scripts/qmd-bootstrap.ts",
	deps: QmdDeps = realDeps,
): QmdSessionResult {
	if (deps.env[QMD_SWITCH] === "off") return { notes: [], refresh: null };
	const entry = deps.resolveEntry();
	if (entry === null) return { notes: [], refresh: null };
	const index = resolveQmdIndex(manifestJson, vaultRoot);
	const notes: { header: string; body: string }[] = [];

	if (index !== null) {
		const probe = buildQmdCommand(entry, ["--index", index, "status"]);
		const status = deps.spawnSync(probe.cmd, probe.args, { timeout: 5_000, shell: probe.shell });
		if (isQmdNativeAbiMismatch(status.stderr ?? "")) {
			const root = qmdPackageRootFromEntry(entry);
			if (root !== null) {
				const rebuild = deps.spawnSync("npm rebuild better-sqlite3", [], { cwd: root, timeout: 20_000, shell: true });
				notes.push({
					header: "### QMD Self-Heal",
					body:
						rebuild.status === 0
							? "⚠️ QMD's native module (better-sqlite3) was ABI-mismatched against this machine's Node version and was rebuilt this session. Search may need one more `qmd update` to catch up; if the qmd MCP tools are still missing, a session restart picks them up."
							: "⚠️ QMD's native module (better-sqlite3) is ABI-mismatched against this machine's Node version, and the automatic `npm rebuild better-sqlite3` failed, so search is likely dead. Fix: run `npm rebuild better-sqlite3` in the @tobilu/qmd package folder, then `qmd update`.",
				});
			}
		}
	}

	const minVersion = parseQmdMinVersion(manifestJson);
	if (minVersion !== null) {
		const cmd = buildQmdCommand(entry, ["--version"]);
		const v = deps.spawnSync(cmd.cmd, cmd.args, { timeout: 5_000, shell: cmd.shell });
		if (v.status === 0 && !qmdVersionAtLeast(v.stdout ?? "", minVersion)) {
			notes.push({
				header: "### QMD Version",
				body: `⚠️ Installed qmd (${(v.stdout ?? "").trim()}) is below this vault's minimum (${minVersion}), so search may misbehave. Update with \`npm i -g @tobilu/qmd\`, then re-run the bootstrap.`,
			});
		}
	}

	const size = index === null ? null : deps.storeSize(resolveIndexStorePath(index, deps.env, deps.home));
	const empty = index !== null && (size === null || size < EMPTY_STORE_BYTES);
	if (empty) {
		deps.spawnDetached(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", bootstrapScript], { cwd: vaultRoot, shell: false });
	} else {
		// cwd is the OS temp folder, so a lingering QMD process never holds the vault folder open on Windows.
		const update = buildQmdCommand(entry, qmdArgsWithIndex(index, ["update"]));
		deps.spawnDetached(update.cmd, update.args, { cwd: tmpdir(), shell: update.shell });
	}
	return { notes, refresh: empty ? "bootstrap" : "update" };
}
