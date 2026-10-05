/**
 * The vendor command line.
 *
 *   node --experimental-strip-types core/vendor/cli.ts check [--vault <dir>] [--record <path>]
 *   node --experimental-strip-types core/vendor/cli.ts record --upstream <checkout> [--vault <dir>] [--record <path>]
 *        [--change <path>=<one line>]... [--set <key>=<value>]... [<path>...]
 *
 * `check` exits 0 when every vendored file matches its record, and 1 with
 * one line per problem otherwise, including a record it cannot verify.
 * `record` (re)hashes the given paths, or every path already in the record,
 * and writes the record; the commit is the upstream checkout's HEAD, which
 * must have no uncommitted changes. Exit 2 is a usage error.
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_RECORD, VendorError, buildRecord, checkRecord, formatRecord, readRecord, resolveInside } from "./vendor.ts";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function pairs(list: readonly string[] | undefined, flag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const item of list ?? []) {
		const at = item.indexOf("=");
		if (at <= 0) throw new UsageError(`${flag} takes <key>=<value>, got ${item}`);
		out[item.slice(0, at)] = item.slice(at + 1);
	}
	return out;
}

class UsageError extends Error {}

export function main(argv: readonly string[], log: (line: string) => void = console.log): number {
	const [command, ...rest] = argv;
	try {
		const { values, positionals } = parseArgs({
			args: [...rest],
			allowPositionals: true,
			options: {
				vault: { type: "string", default: "." },
				record: { type: "string", default: DEFAULT_RECORD },
				upstream: { type: "string" },
				change: { type: "string", multiple: true },
				set: { type: "string", multiple: true },
			},
		});
		const vault = path.resolve(values.vault!);
		const recordFile = resolveInside(vault, values.record!);

		if (command === "check") {
			if (!existsSync(recordFile)) {
				log(`vendor: no record at ${values.record}`);
				return 1;
			}
			const record = readRecord(recordFile);
			const problems = checkRecord(vault, record);
			for (const p of problems) log(`vendor: ${p.file === null ? "" : `${p.file}: `}${p.problem}`);
			if (problems.length === 0) log(`vendor: ${Object.keys(record.files).length} files match ${values.record} (${record.repository} at ${record.commit.slice(0, 7)})`);
			return problems.length === 0 ? 0 : 1;
		}

		if (command === "record") {
			if (!values.upstream) throw new UsageError("record needs --upstream <checkout>");
			const upstreamRoot = path.resolve(values.upstream);
			const commit = git(upstreamRoot, ["rev-parse", "HEAD"]);
			if (git(upstreamRoot, ["status", "--porcelain"]) !== "") throw new VendorError("the upstream checkout has uncommitted changes; record from a clean checkout");
			const existing = existsSync(recordFile) ? readRecord(recordFile) : null;
			const set = pairs(values.set, "--set");
			for (const k of ["schemaVersion", "commit", "files"]) if (k in set) throw new UsageError(`--set cannot set ${k}`);
			const base = { ...(existing ?? {}), ...set } as Parameters<typeof buildRecord>[0]["base"];
			if (typeof base.repository !== "string") throw new UsageError("a new record needs --set repository=<url>");
			const paths = positionals.length ? positionals : Object.keys(existing?.files ?? {});
			if (paths.length === 0) throw new UsageError("record needs paths, or an existing record to re-record");
			const record = buildRecord({ vault, upstreamRoot, commit, base, paths, changes: pairs(values.change, "--change") });
			writeFileSync(recordFile, formatRecord(record));
			log(`vendor: recorded ${Object.keys(record.files).length} files from ${record.repository} at ${commit.slice(0, 7)}`);
			return 0;
		}

		throw new UsageError(command ? `unknown command ${command}` : "no command: check or record");
	} catch (err) {
		const code = (err as { code?: unknown }).code;
		if (err instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
			log(`vendor: ${(err as Error).message}`);
			return 2;
		}
		if (err instanceof VendorError) {
			for (const line of err.message.split("\n")) log(`vendor: ${line}`);
			return 1;
		}
		throw err;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main(process.argv.slice(2));
}
