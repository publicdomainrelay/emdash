import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { CloudflareSandboxRunner } from "@emdash-cms/cloudflare/sandbox";
import type { Database, PluginManifest, SandboxedPluginInstance } from "emdash";
import { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginTestHost, type PluginTestHost } from "../src/index.js";

const ECHO_MODULE = [
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0c, 0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f,
	0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7e, 0x03, 0x03, 0x02, 0x00, 0x01, 0x05, 0x03, 0x01, 0x00, 0x01,
	0x07, 0x19, 0x03, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x05, 0x61, 0x6c, 0x6c,
	0x6f, 0x63, 0x00, 0x00, 0x04, 0x65, 0x63, 0x68, 0x6f, 0x00, 0x01, 0x0a, 0x14, 0x02, 0x05, 0x00,
	0x41, 0x80, 0x08, 0x0b, 0x0c, 0x00, 0x20, 0x00, 0xad, 0x42, 0x20, 0x86, 0x20, 0x01, 0xad, 0x84,
	0x0b,
];

const IMPORTING_MODULE = [
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02, 0x09,
	0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
];

const PLUGIN_CODE = `export default {
	routes: {
		probe: async (_request, ctx) => ({ hasWasm: ctx.wasm !== undefined }),
		run: async ({ input }, ctx) => {
			try {
				const output = await ctx.wasm.run({
					module: new Uint8Array(input.module),
					entry: input.entry,
					input: input.payload,
					sha256: input.sha256,
				});
				return { ok: true, output };
			} catch (error) {
				return { ok: false, name: error.name, code: error.code, message: error.message };
			}
		},
	},
};
`;

function manifest(id: string, capabilities: string[]): PluginManifest {
	return {
		id,
		version: "1.0.0",
		capabilities,
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: ["probe", "run"],
		admin: {},
	} as unknown as PluginManifest;
}

const REQUEST = {
	url: "https://plugin.test/_emdash/api/plugins/wasm/run",
	method: "POST",
	headers: {},
	meta: { ip: null, userAgent: null, referer: null, geo: null },
};

async function sha256Hex(bytes: number[]): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let runner: CloudflareSandboxRunner | undefined;
let db: Kysely<Database> | undefined;
let host: PluginTestHost | undefined;

afterEach(async () => {
	await runner?.terminateAll();
	await db?.destroy();
	await host?.dispose();
	runner = undefined;
	db = undefined;
	host = undefined;
});

async function loadPlugin(id: string, capabilities: string[]): Promise<SandboxedPluginInstance> {
	db = new Kysely<Database>({ dialect: createDialect({ binding: "DB", session: "disabled" }) });
	runner = new CloudflareSandboxRunner({
		db,
		siteInfo: { name: "EmDash plugin test site", url: "https://plugin.test", locale: "en" },
	});
	return runner.load(manifest(id, capabilities), PLUGIN_CODE);
}

function run(plugin: SandboxedPluginInstance, input: Record<string, unknown>) {
	return plugin.invokeRoute("run", input, REQUEST);
}

describe("wasm:execute in the Cloudflare sandbox", () => {
	it("runs a module in a Worker Loader isolate and returns its JSON output", async () => {
		const plugin = await loadPlugin("wasm-echo", ["wasm:execute"]);
		await expect(plugin.invokeRoute("probe", {}, REQUEST)).resolves.toEqual({ hasWasm: true });
		const payload = { status: "🦋", nested: [1, 2, 3] };
		await expect(
			run(plugin, {
				module: ECHO_MODULE,
				entry: "echo",
				payload,
				sha256: await sha256Hex(ECHO_MODULE),
			}),
		).resolves.toEqual({ ok: true, output: payload });
		await expect(run(plugin, { module: ECHO_MODULE, entry: "echo", payload: 7 })).resolves.toEqual({
			ok: true,
			output: 7,
		});
	});

	it("omits ctx.wasm without the capability", async () => {
		const plugin = await loadPlugin("wasm-absent", []);
		await expect(plugin.invokeRoute("probe", {}, REQUEST)).resolves.toEqual({ hasWasm: false });
	});

	it("rejects modules that declare imports", async () => {
		const plugin = await loadPlugin("wasm-imports", ["wasm:execute"]);
		const result = await run(plugin, { module: IMPORTING_MODULE, entry: "echo" });
		expect(result).toMatchObject({
			ok: false,
			name: "WasmRunError",
			code: "WASM_IMPORTS_NOT_ALLOWED",
		});
		expect((result as { message: string }).message).toMatch(/^WASM_IMPORTS_NOT_ALLOWED: /);
	});

	it("rejects a digest mismatch before loading the module", async () => {
		const plugin = await loadPlugin("wasm-digest", ["wasm:execute"]);
		const result = await run(plugin, {
			module: ECHO_MODULE,
			entry: "echo",
			sha256: "0".repeat(64),
		});
		expect(result).toMatchObject({ ok: false, code: "WASM_DIGEST_MISMATCH" });
		expect((result as { message: string }).message).toMatch(/^WASM_DIGEST_MISMATCH: /);
	});

	it("rejects a missing entry export", async () => {
		const plugin = await loadPlugin("wasm-abi", ["wasm:execute"]);
		await expect(run(plugin, { module: ECHO_MODULE, entry: "missing" })).resolves.toMatchObject({
			ok: false,
			code: "WASM_ABI_INVALID",
		});
	});
});

describe("wasm:execute through the plugin test host", () => {
	it("runs the fixture's wasm-run route", async () => {
		host = await createPluginTestHost();
		expect(host.manifest.capabilities).toContain("wasm:execute");
		await expect(
			host.invokeRoute("wasm-run", {
				module: ECHO_MODULE,
				entry: "echo",
				input: { hello: "world" },
				sha256: await sha256Hex(ECHO_MODULE),
			}),
		).resolves.toEqual({ ok: true, output: { hello: "world" } });
		const mismatch = await host.invokeRoute("wasm-run", {
			module: ECHO_MODULE,
			entry: "echo",
			sha256: "f".repeat(64),
		});
		expect(mismatch).toMatchObject({ ok: false });
		expect((mismatch as { message: string }).message).toMatch(/^WASM_DIGEST_MISMATCH: /);
		const imports = await host.invokeRoute("wasm-run", { module: IMPORTING_MODULE, entry: "echo" });
		expect((imports as { message: string }).message).toMatch(/^WASM_IMPORTS_NOT_ALLOWED: /);
	});
});
