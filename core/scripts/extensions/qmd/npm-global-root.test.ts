/**
 * npmGlobalRoot, ported from obsidian-mind ac5a613 (its PR #382, for its issue #349; mindframe #123): where npm keeps global
 * packages, worked out without spawning npm in five cheap exact cases, and null (ask npm) otherwise.
 * The cases are obsidian-mind's tests/qmd.test.ts, against the qmd extension's lib/qmd.ts only, since
 * mindframe carries no qmd-mcp.mjs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { npmGlobalRoot } from "./lib/qmd.ts";

// Where npm keeps global packages, without spawning npm (obsidian-mind #349): only the
// cheap exact cases npmGlobalRoot's doc lists, and null (ask npm) for the
// rest. The last case checks the real npm on this machine.

/** The real npm's answer on this machine, asked at most once; null without npm. */
let npmAsked: string | null | undefined;
const npmAnswer = (): string | null => {
	if (npmAsked === undefined) {
		const npm = spawnSync("npm root -g", { shell: true, encoding: "utf8", timeout: 15_000, windowsHide: true });
		const asked = (npm.stdout ?? "").trim();
		npmAsked = npm.status === 0 && asked !== "" ? asked : null;
	}
	return npmAsked;
};

describe("npmGlobalRoot", () => {
	const home = join(tmpdir(), "home");
	const nodeDir = join(tmpdir(), "nodejs");
	const winNpm = join(nodeDir, "node_modules", "npm");
	const posixNpm = join(nodeDir, "lib", "node_modules", "npm");
	// npm sits beside this Node unless a test says otherwise.
	const npmBeside = { [join(winNpm, "package.json")]: "{}", [join(posixNpm, "package.json")]: "{}" };
	const files = (map: Record<string, string>) => (path: string) => ({ ...npmBeside, ...map })[path] ?? null;
	const win = (env: Record<string, string> = {}, text: Record<string, string> = {}) =>
		npmGlobalRoot({ env, platform: "win32", execPath: join(nodeDir, "node.exe"), home, readText: files(text) });
	const posix = (env: Record<string, string> = {}, text: Record<string, string> = {}) =>
		npmGlobalRoot({ env, platform: "linux", execPath: join(nodeDir, "bin", "node"), home, readText: files(text) });
	const winBuiltin = join(winNpm, "npmrc");
	const posixBuiltin = join(posixNpm, "npmrc");
	const userNpmrc = join(home, ".npmrc");

	test("5: nothing configured is Node's own prefix, laid out per platform", () => {
		assert.equal(win(), join(nodeDir, "node_modules"));
		assert.equal(posix(), join(nodeDir, "lib", "node_modules"));
	});

	test("1: npm_config_prefix in the env, in any case, beats every npmrc", () => {
		const p = join(tmpdir(), "env-prefix");
		const npmrc = { [userNpmrc]: "prefix=/elsewhere" };
		assert.equal(win({ npm_config_prefix: p }, npmrc), join(p, "node_modules"));
		assert.equal(posix({ NPM_CONFIG_PREFIX: p }, npmrc), join(p, "lib", "node_modules"));
		assert.equal(posix({ Npm_Config_Prefix: p }), join(p, "lib", "node_modules"));
	});

	test("1: an env prefix that isn't absolute, or holds ${, asks npm", () => {
		assert.equal(posix({ npm_config_prefix: "relative/dir" }), null);
		assert.equal(posix({ npm_config_prefix: join(tmpdir(), "${NAME}") }), null);
	});

	test("1: env values are read as npm reads them: trimmed, empty skipped, the last winning", () => {
		const a = join(tmpdir(), "a");
		const b = join(tmpdir(), "b");
		assert.equal(posix({ npm_config_prefix: `${a} ` }), join(a, "lib", "node_modules"));
		assert.equal(posix({ npm_config_prefix: "" }), join(nodeDir, "lib", "node_modules"), "empty is unset");
		assert.equal(posix({ npm_config_prefix: a, NPM_CONFIG_PREFIX: b }), join(b, "lib", "node_modules"));
	});

	test("1: on a Windows host, a drive-relative prefix asks npm", { skip: process.platform !== "win32" }, () => {
		assert.equal(win({ npm_config_prefix: "\\npm" }), null);
		assert.equal(win({ npm_config_prefix: "/npm" }), null);
	});

	test("2: PREFIX, DESTDIR, npm_config_userconfig or npm_config_globalconfig set asks npm", () => {
		for (const key of ["PREFIX", "DESTDIR", "npm_config_userconfig", "NPM_CONFIG_GLOBALCONFIG"]) {
			assert.equal(posix({ [key]: join(tmpdir(), "x") }), null, key);
		}
	});

	test("3: a user or global npmrc that mentions prefix or globalconfig, sections included, asks npm", () => {
		assert.equal(posix({}, { [userNpmrc]: "prefix=/opt/npm" }), null);
		assert.equal(posix({}, { [userNpmrc]: "[project]\nprefix = /opt/npm" }), null);
		assert.equal(posix({}, { [userNpmrc]: `globalconfig=${join(tmpdir(), "g")}` }), null);
		assert.equal(posix({}, { [join(nodeDir, "etc", "npmrc")]: "prefix=/opt/npm" }), null);
		assert.equal(win({}, { [join(nodeDir, "etc", "npmrc")]: "prefix=C:\\npm" }), null);
	});

	test("3: an npmrc with only auth, registry or save-prefix lines doesn't count", () => {
		const auth = {
			[userNpmrc]:
				"registry=https://registry.example.com/\n//registry.example.com/:_authToken=abc\nsave-prefix=~\n; prefix=/commented\n# ${NPMKEY}=/commented\n",
		};
		assert.equal(posix({}, auth), join(nodeDir, "lib", "node_modules"));
	});

	test("3: a key npm would build from ${...} asks npm", () => {
		assert.equal(posix({}, { [userNpmrc]: "${NPMKEY}=/opt/g" }), null);
	});

	test("3: HOME is read before the OS home", () => {
		const h = join(tmpdir(), "h");
		const at = (text: Record<string, string>) =>
			npmGlobalRoot({ env: { HOME: h }, platform: "linux", execPath: join(nodeDir, "bin", "node"), readText: files(text) });
		assert.equal(at({ [join(h, ".npmrc")]: "prefix=/opt/npm" }), null);
		assert.equal(at({}), join(nodeDir, "lib", "node_modules"));
	});

	test("4: the Windows installer's builtin npmrc is %APPDATA%\\npm, comments and blank lines aside", () => {
		const appdata = join(tmpdir(), "Roaming");
		assert.equal(
			win({ APPDATA: appdata }, { [winBuiltin]: "; installer default\n\nprefix=${APPDATA}\\npm\n" }),
			join(appdata, "npm", "node_modules"),
		);
	});

	test("4: anything else in the builtin npmrc asks npm", () => {
		const appdata = join(tmpdir(), "Roaming");
		assert.equal(win({ APPDATA: appdata }, { [winBuiltin]: "prefix=C:\\npm\\prefix" }), null);
		assert.equal(win({}, { [winBuiltin]: "prefix=${APPDATA}\\npm" }), null, "no APPDATA to expand");
		assert.equal(
			win({ APPDATA: appdata }, { [winBuiltin]: "prefix=${APPDATA}\\npm\nuserconfig=D:\\cfg\\npmrc" }),
			null,
			"another setting beside the installer's line",
		);
		assert.equal(posix({}, { [posixBuiltin]: "prefix=/opt/homebrew" }), null);
		assert.equal(posix({}, { [posixBuiltin]: "userconfig=/etc/other-npmrc" }), null, "it moves the user npmrc");
	assert.equal(posix({}, { [posixBuiltin]: "${NPM_PREFIX_KEY}=/opt/x" }), null, "a key npm would build from ${...}");
	});

	test("4: other keys in the builtin npmrc don't count", () => {
		assert.equal(posix({}, { [posixBuiltin]: "update-notifier=false\n" }), join(nodeDir, "lib", "node_modules"));
		const appdata = join(tmpdir(), "Roaming");
		assert.equal(
			win({ APPDATA: appdata }, { [winBuiltin]: "update-notifier=false\nprefix=${APPDATA}\\npm" }),
			join(appdata, "npm", "node_modules"),
		);
	});

	test("4 and 5: with no npm beside this Node (Homebrew, Debian), ask npm", () => {
		const noNpm = () => null;
		assert.equal(npmGlobalRoot({ env: {}, platform: "linux", execPath: join(nodeDir, "bin", "node"), home, readText: noNpm }), null);
		assert.equal(npmGlobalRoot({ env: {}, platform: "win32", execPath: join(nodeDir, "node.exe"), home, readText: noNpm }), null);
	});

	test("4: the global npmrc under %APPDATA%\\npm still counts", () => {
		const appdata = join(tmpdir(), "Roaming");
		assert.equal(
			win(
				{ APPDATA: appdata },
				{ [winBuiltin]: "prefix=${APPDATA}\\npm", [join(appdata, "npm", "etc", "npmrc")]: "prefix=D:\\npm" },
			),
			null,
		);
		assert.equal(
			win({ APPDATA: appdata }, { [winBuiltin]: "prefix=${APPDATA}\\npm", [join(appdata, "npm", "etc", "npmrc")]: "globalconfig=D:\\other" }),
			null,
			"a globalconfig there too",
		);
	});

	// The property that matters: a root worked out here that holds qmd is
	// the root npm would give. A null only costs the spawn it would save.
	test("where it finds qmd on this machine, npm agrees", (t) => {
		const ours = npmGlobalRoot();
		if (ours === null || !existsSync(join(ours, "@tobilu", "qmd", "dist", "cli", "qmd.js"))) {
			return t.skip("no qmd under a worked-out root here; the caller asks npm");
		}
		const answer = npmAnswer();
		if (answer === null) return t.skip("npm is not available here");
		// Windows and macOS's default filesystem ignore case; Linux doesn't, so a case-only difference there is a different folder.
	const fold = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? resolve(p).toLowerCase() : resolve(p));
	assert.equal(fold(ours), fold(answer));
	});
});
