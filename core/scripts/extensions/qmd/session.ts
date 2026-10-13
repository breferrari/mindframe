/**
 * QMD's session-start work: the notes the qmd extension's sections render,
 * and the refresh its session-start effect starts (index.ts, #95). It was
 * the core's `core/qmd-session.ts` until #70 moved it here: a vault that
 * wants it declares the extension.
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
 * `VAULT_QMD_REFRESH=off` turns off only the detached refresh, this update
 * or bootstrap and lib/refresh.ts's worker, so a test run that sets it never
 * leaves a worker behind (#94, the same switch as obsidian-mind #338). The
 * probes and notes still run.
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { statSync as nodeStatSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { ManifestObject } from "../../core/index.ts";
import { buildQmdCommand, qmdVersionAtLeast, resolveQmdEntry } from "./lib/qmd.ts";
import { qmdOff, refreshDisabled } from "./lib/switches.ts";
import {
	isQmdNativeAbiMismatch,
	qmdArgsWithIndex,
	qmdMinVersionOf,
	qmdPackageRootFromEntry,
	resolveIndexStorePath,
	resolveQmdIndexOf,
} from "./lib/index-name.ts";

/** The notes' headings, one section each in the extension. */
export const SELF_HEAL_HEADER = "### QMD Self-Heal";
export const VERSION_HEADER = "### QMD Version";

/** A store below this size holds no indexed notes: bootstrap rather than update. */
export const EMPTY_STORE_BYTES = 500_000;

/** The bootstrap a missing or near-empty store gets, vault-relative, run with the vault as cwd. */
export const BOOTSTRAP_SCRIPT = ".scripts/qmd-bootstrap.ts";

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

/** A load-bearing note for the session context, as heading and body. */
export type QmdNote = { readonly header: string; readonly body: string };

/**
 * QMD's notes for the vault at `vaultRoot`, on its parsed manifest: the
 * self-heal (an ABI-mismatched binding, rebuilt) and the version floor. The
 * extension's sections render them; they start nothing in the background.
 */
export function qmdNotesOf(vaultRoot: string, manifest: ManifestObject, deps: QmdDeps = realDeps): readonly QmdNote[] {
	if (qmdOff(deps.env)) return [];
	const entry = deps.resolveEntry();
	if (entry === null) return [];
	const index = resolveQmdIndexOf(manifest, vaultRoot);
	const notes: QmdNote[] = [];

	if (index !== null) {
		const probe = buildQmdCommand(entry, ["--index", index, "status"]);
		const status = deps.spawnSync(probe.cmd, probe.args, { timeout: 5_000, shell: probe.shell });
		if (isQmdNativeAbiMismatch(status.stderr ?? "")) {
			const root = qmdPackageRootFromEntry(entry);
			if (root !== null) {
				const rebuild = deps.spawnSync("npm rebuild better-sqlite3", [], { cwd: root, timeout: 20_000, shell: true });
				notes.push({
					header: SELF_HEAL_HEADER,
					body:
						rebuild.status === 0
							? "⚠️ QMD's native module (better-sqlite3) was ABI-mismatched against this machine's Node version and was rebuilt this session. Search may need one more `qmd update` to catch up; if the qmd MCP tools are still missing, a session restart picks them up."
							: "⚠️ QMD's native module (better-sqlite3) is ABI-mismatched against this machine's Node version, and the automatic `npm rebuild better-sqlite3` failed, so search is likely dead. Fix: run `npm rebuild better-sqlite3` in the @tobilu/qmd package folder, then `qmd update`.",
				});
			}
		}
	}

	const minVersion = qmdMinVersionOf(manifest);
	if (minVersion !== null) {
		const cmd = buildQmdCommand(entry, ["--version"]);
		const v = deps.spawnSync(cmd.cmd, cmd.args, { timeout: 5_000, shell: cmd.shell });
		if (v.status === 0 && !qmdVersionAtLeast(v.stdout ?? "", minVersion)) {
			notes.push({
				header: VERSION_HEADER,
				body: `⚠️ Installed qmd (${(v.stdout ?? "").trim()}) is below this vault's minimum (${minVersion}), so search may misbehave. Update with \`npm i -g @tobilu/qmd\`, then re-run the bootstrap.`,
			});
		}
	}
	return notes;
}

/**
 * QMD's session-start refresh for the vault at `vaultRoot`, the extension's
 * session-start effect (#95): a detached `qmd update` on this vault's index,
 * or the idempotent bootstrap (BOOTSTRAP_SCRIPT) when the store is missing or
 * implausibly small. Returns what it started.
 */
export function qmdSessionRefreshOf(vaultRoot: string, manifest: ManifestObject, deps: QmdDeps = realDeps): "update" | "bootstrap" | null {
	if (qmdOff(deps.env) || refreshDisabled(deps.env)) return null;
	const entry = deps.resolveEntry();
	if (entry === null) return null;
	const index = resolveQmdIndexOf(manifest, vaultRoot);
	const size = index === null ? null : deps.storeSize(resolveIndexStorePath(index, deps.env, deps.home));
	const empty = index !== null && (size === null || size < EMPTY_STORE_BYTES);
	if (empty) {
		deps.spawnDetached(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", BOOTSTRAP_SCRIPT], { cwd: vaultRoot, shell: false });
	} else {
		// cwd is the OS temp folder, so a lingering QMD process never holds the vault folder open on Windows.
		const update = buildQmdCommand(entry, qmdArgsWithIndex(index, ["update"]));
		deps.spawnDetached(update.cmd, update.args, { cwd: tmpdir(), shell: update.shell });
	}
	return empty ? "bootstrap" : "update";
}
