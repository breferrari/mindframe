import { describe, test } from "node:test";
import { parseDeclarations } from "./registry.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QMD_DECLARATION, migrationNotes, openVault, readManifest } from "./context.ts";

function vault(t: { after: (fn: () => void) => void }, manifest?: string): string {
	const root = mkdtempSync(join(tmpdir(), "mf-context-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	if (manifest !== undefined) writeFileSync(join(root, "vault-manifest.json"), manifest);
	return root;
}

function withExtension(root: string): void {
	mkdirSync(join(root, "ext"), { recursive: true });
	writeFileSync(join(root, "ext", "a.mjs"), 'export default { id: "a", sections: [{ id: "s", header: "## A", render: () => "A" }] }\n');
}

const declared = JSON.stringify({ template: "demo", extensions: [{ id: "a", module: "ext/a.mjs", events: ["session-start"] }] });

test("readManifest: parsed when valid, null when missing, malformed or not an object", (t) => {
	assert.deepEqual(readManifest(vault(t, '{"template":"demo"}')), { template: "demo" });
	assert.equal(readManifest(vault(t)), null);
	assert.equal(readManifest(vault(t, "{ not json")), null);
	assert.equal(readManifest(vault(t, "[1, 2]")), null);
});

test("openVault loads the registry for its event only, and hands back one context", async (t) => {
	const root = vault(t, declared);
	withExtension(root);
	const start = await openVault(root, "session-start", {}, 1234);
	assert.equal(start.registry.loaded.length, 1);
	assert.deepEqual(start.ctx, { vaultRoot: root, manifest: JSON.parse(declared), now: 1234 });
	assert.equal(start.ctx.manifest, start.manifest, "one parse, shared");
	const stop = await openVault(root, "stop", {});
	assert.equal(stop.registry.loaded.length, 0, "an extension declared for session-start is not loaded at Stop");
});

test("openVault with no manifest: no extensions, no throw", async (t) => {
	const { manifest, registry } = await openVault(vault(t), "prompt", {});
	assert.equal(manifest, null);
	assert.equal(registry.loaded.length, 0);
	assert.deepEqual(registry.failures, []);
});

test("openVault honours the kill switch", async (t) => {
	const root = vault(t, declared);
	withExtension(root);
	const { registry } = await openVault(root, "session-start", { VAULT_EXTENSIONS: "off" });
	assert.equal(registry.loaded.length, 0);
	assert.equal(registry.off, true);
});

describe("migrationNotes: qmd set in the manifest, no qmd extension declared (#70)", () => {
	const qmd = { id: "qmd", module: ".claude/scripts/extensions/qmd/index.ts", events: ["session-start"] };
	const notes = (m: Record<string, unknown> | null) => migrationNotes(m === null ? null : Object.freeze(m));

	test("a note naming the declaration to add, for either key", () => {
		for (const m of [{ qmd_index: "my-wiki" }, { qmd_min_version: "2.0.0" }, { qmd_index: "x", qmd_min_version: "2.0.0", extensions: [] }]) {
			const out = notes(m);
			assert.equal(out.length, 1, JSON.stringify(m));
			assert.ok(out[0]?.includes(QMD_DECLARATION), "names the line to add");
		}
	});

	test("an empty qmd_index counts as set: it means derive the name, still a qmd vault", () => {
		assert.equal(notes({ template: "obsidian-mind", qmd_index: "" }).length, 1);
	});

	test("no note once a qmd extension is declared, enabled or not, whatever its module path", () => {
		assert.deepEqual(notes({ qmd_index: "", extensions: [qmd] }), []);
		assert.deepEqual(notes({ qmd_index: "", extensions: [{ ...qmd, enabled: false }] }), []);
		assert.deepEqual(notes({ qmd_min_version: "2.0.0", extensions: [{ ...qmd, module: "ext/my-qmd.ts" }] }), []);
	});

	test("no note when qmd isn't set, or there is no manifest", () => {
		assert.deepEqual(notes({ template: "demo", extensions: [] }), []);
		assert.deepEqual(notes({ qmd_index: null, qmd_min_version: 2 }), [], "only a string value sets a key");
		assert.deepEqual(notes(null), []);
	});

	test("a malformed extensions value declares nothing: the note still shows, and nothing throws", () => {
		for (const extensions of ["qmd", { qmd }, [null, 3, "qmd", { id: 7 }]]) assert.equal(notes({ qmd_index: "", extensions }).length, 1, JSON.stringify(extensions));
	});

	test("a qmd declaration the registry refuses doesn't count: it would never load", () => {
		for (const bad of [{ ...qmd, module: "/abs/qmd.ts" }, { ...qmd, events: [] }, { ...qmd, timeoutMs: -1 }]) {
			assert.equal(notes({ qmd_index: "", extensions: [bad] }).length, 1, JSON.stringify(bad));
		}
	});

	test("QMD_DECLARATION is a declaration the registry accepts", () => {
		assert.deepEqual(parseDeclarations(Object.freeze({ extensions: [JSON.parse(QMD_DECLARATION)] })).failures, []);
	});
});
