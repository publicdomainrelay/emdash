import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import { generateWasmRunnerSource, sandboxWasmRun } from "../../src/sandbox/bridge-wasm.js";
import { PluginBridge } from "../../src/sandbox/bridge.js";
import type { WorkerLoader, WorkerLoaderConfig } from "../../src/sandbox/types.js";
import { generatePluginWrapper } from "../../src/sandbox/wrapper.js";

const ECHO_MODULE = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0c, 0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f,
	0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7e, 0x03, 0x03, 0x02, 0x00, 0x01, 0x05, 0x03, 0x01, 0x00, 0x01,
	0x07, 0x19, 0x03, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x05, 0x61, 0x6c, 0x6c,
	0x6f, 0x63, 0x00, 0x00, 0x04, 0x65, 0x63, 0x68, 0x6f, 0x00, 0x01, 0x0a, 0x14, 0x02, 0x05, 0x00,
	0x41, 0x80, 0x08, 0x0b, 0x0c, 0x00, 0x20, 0x00, 0xad, 0x42, 0x20, 0x86, 0x20, 0x01, 0xad, 0x84,
	0x0b,
]);

const IMPORTING_MODULE = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02, 0x09,
	0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
]);

type RunnerEntrypoint = { run(entry: string, inputJson: string): Promise<unknown> };

function evaluatingLoader() {
	const configs: Array<{ name: string; config: WorkerLoaderConfig }> = [];
	const loader: WorkerLoader = {
		get(name, getCode) {
			return {
				fetch: () => Promise.reject(new Error("not used")),
				getEntrypoint<T>() {
					const entrypoint = (async () => {
						const config = await getCode();
						configs.push({ name, config });
						const wasm = config.modules["module.wasm"] as { wasm: ArrayBuffer };
						const compiled = await WebAssembly.compile(wasm.wasm);
						const runner = config.modules["runner.js"] as { js: string };
						const source = runner.js
							.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
							.replace('import compiled from "./module.wasm";', "")
							.replace("export default class WasmRunner", "return class WasmRunner");
						const factory = new Function("WorkerEntrypoint", "compiled", source);
						const Runner = factory(
							class {
								env = {};
							},
							compiled,
						) as new () => RunnerEntrypoint;
						return new Runner();
					})();
					return {
						run: async (entry: string, inputJson: string) =>
							(await entrypoint).run(entry, inputJson),
					} as T;
				},
			};
		},
	};
	return { loader, configs };
}

function bridgeWith(capabilities: string[], loader?: WorkerLoader): PluginBridge {
	return new PluginBridge(
		{
			props: {
				pluginId: "wasm-plugin",
				pluginVersion: "1.0.0",
				capabilities,
				allowedHosts: [],
				storageCollections: [],
			},
		} as never,
		{ DB: {}, LOADER: loader } as never,
	);
}

describe("PluginBridge.wasmRun", () => {
	it("runs a module in a Dynamic Worker keyed by digest without network access", async () => {
		const { loader, configs } = evaluatingLoader();
		const bridge = bridgeWith(["wasm:execute"], loader);
		await expect(
			bridge.wasmRun({ module: ECHO_MODULE, entry: "echo", input: { ok: [1, 2] } }),
		).resolves.toEqual({ ok: [1, 2] });
		expect(configs).toHaveLength(1);
		expect(configs[0]!.name).toMatch(/^emdash-wasm-[0-9a-f]{64}$/);
		expect(configs[0]!.config).toMatchObject({
			mainModule: "runner.js",
			globalOutbound: null,
			limits: { cpuMs: 5000 },
		});
		expect(Object.keys(configs[0]!.config.modules).toSorted()).toEqual([
			"module.wasm",
			"runner.js",
		]);
	});

	it("requires the wasm:execute capability", async () => {
		const { loader } = evaluatingLoader();
		await expect(
			bridgeWith([], loader).wasmRun({ module: ECHO_MODULE, entry: "echo" }),
		).rejects.toThrow("Missing capability: wasm:execute");
	});

	it("reports WASM_UNAVAILABLE without a Worker Loader binding", async () => {
		await expect(
			bridgeWith(["wasm:execute"]).wasmRun({ module: ECHO_MODULE, entry: "echo" }),
		).rejects.toThrow(/^WASM_UNAVAILABLE: /);
	});

	it("keeps the error code from the runner isolate", async () => {
		const { loader } = evaluatingLoader();
		const bridge = bridgeWith(["wasm:execute"], loader);
		await expect(bridge.wasmRun({ module: IMPORTING_MODULE, entry: "echo" })).rejects.toThrow(
			/^WASM_IMPORTS_NOT_ALLOWED: /,
		);
		await expect(
			bridge.wasmRun({ module: ECHO_MODULE, entry: "echo", sha256: "0".repeat(64) }),
		).rejects.toThrow(/^WASM_DIGEST_MISMATCH: /);
	});

	it("times out a run that does not finish", async () => {
		const loader: WorkerLoader = {
			get: () => ({
				fetch: () => Promise.reject(new Error("not used")),
				getEntrypoint: <T>() => ({ run: () => new Promise(() => {}) }) as T,
			}),
		};
		await expect(
			sandboxWasmRun({ module: ECHO_MODULE, entry: "echo" }, loader, 10),
		).rejects.toThrow(/^WASM_TIMEOUT: /);
	});

	it("maps a CPU limit failure to WASM_TIMEOUT and loader failures to WASM_TRAP", async () => {
		const failing = (message: string): WorkerLoader => ({
			get: () => ({
				fetch: () => Promise.reject(new Error("not used")),
				getEntrypoint: <T>() => ({ run: () => Promise.reject(new Error(message)) }) as T,
			}),
		});
		await expect(
			sandboxWasmRun(
				{ module: ECHO_MODULE, entry: "echo" },
				failing("Worker exceeded CPU time limit."),
			),
		).rejects.toThrow(/^WASM_TIMEOUT: /);
		await expect(
			sandboxWasmRun({ module: ECHO_MODULE, entry: "echo" }, failing("boom")),
		).rejects.toThrow("WASM_TRAP: boom");
	});

	it("builds a runner module that imports the compiled wasm module", () => {
		const source = generateWasmRunnerSource();
		expect(source).toContain('import compiled from "./module.wasm";');
		expect(source).toContain("runWasmJsonAbi(compiled, entry, inputJson, WASM_LIMITS)");
	});
});

function wrapperEntrypoint(capabilities: string[]) {
	const source = generatePluginWrapper({
		id: "wasm-plugin",
		version: "1.0.0",
		capabilities,
		allowedHosts: [],
		storage: {},
		hooks: ["plugin:activate"],
		routes: [],
		admin: {},
	} as never)
		.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
		.replace('import pluginModule from "sandbox-plugin.js";', "")
		.replace("export default class PluginEntrypoint", "return class PluginEntrypoint");
	class WorkerEntrypoint {
		constructor(readonly env: Record<string, unknown>) {}
	}
	const pluginModule = {
		hooks: {
			"plugin:activate": async (event: { request?: unknown }, ctx: Record<string, any>) => {
				if (!event.request) return { hasWasm: ctx.wasm !== undefined };
				try {
					return { output: await ctx.wasm.run(event.request) };
				} catch (error) {
					const failure = error as Error & { code?: string };
					return { name: failure.name, code: failure.code, message: failure.message };
				}
			},
		},
	};
	const factory = new Function("WorkerEntrypoint", "pluginModule", source);
	return factory(WorkerEntrypoint, pluginModule) as new (env: unknown) => {
		invokeHook(name: string, event: unknown): Promise<unknown>;
	};
}

describe("Cloudflare generated ctx.wasm", () => {
	it("is undefined without the capability", async () => {
		const Entrypoint = wrapperEntrypoint([]);
		await expect(new Entrypoint({ BRIDGE: {} }).invokeHook("plugin:activate", {})).resolves.toEqual(
			{ hasWasm: false },
		);
	});

	it("forwards runs to bridge.wasmRun and restores the error code", async () => {
		const wasmRun = vi
			.fn()
			.mockResolvedValueOnce({ echoed: true })
			.mockRejectedValueOnce(
				new Error("WasmRunError: WASM_DIGEST_MISMATCH: module digest does not match sha256"),
			);
		const Entrypoint = wrapperEntrypoint(["wasm:execute"]);
		const entrypoint = new Entrypoint({ BRIDGE: { wasmRun } });
		const request = { module: ECHO_MODULE, entry: "echo", input: { a: 1 }, sha256: "ab" };
		await expect(entrypoint.invokeHook("plugin:activate", { request })).resolves.toEqual({
			output: { echoed: true },
		});
		expect(wasmRun).toHaveBeenCalledWith(request);
		await expect(entrypoint.invokeHook("plugin:activate", { request })).resolves.toEqual({
			name: "WasmRunError",
			code: "WASM_DIGEST_MISMATCH",
			message: "WASM_DIGEST_MISMATCH: module digest does not match sha256",
		});
	});
});
