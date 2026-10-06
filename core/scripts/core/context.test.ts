import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVault, readManifest } from "./context.ts";

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
