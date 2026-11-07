import { compileFunction } from "node:vm";

import { describe, expect, it } from "vitest";

import { generatePluginWrapper } from "../src/sandbox/wrapper.js";
import { ECHO_MODULE, toBase64 } from "./wasm-fixtures.js";

type WasmContext = {
	wasm?: {
		run(request: {
			module: unknown;
			entry: string;
			input?: unknown;
			sha256?: string;
		}): Promise<unknown>;
	};
};

function createContext(capabilities: string[], fetch: (url: string, init: RequestInit) => unknown) {
	const generated = generatePluginWrapper(
		{
			id: "wasm-wrapper",
			version: "1.0.0",
			capabilities,
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: [],
			admin: {},
		},
		{ backingServiceUrl: "http://bridge", authToken: "auth", invokeToken: "invoke" },
	);
	const end = generated.indexOf("\nexport default {");
	if (end < 0) throw new Error("Generated worker entry point is missing");
	const source = generated
		.slice(0, end)
		.replace('import pluginModule from "sandbox-plugin.js";', "");
	const factory = compileFunction(`${source}\nreturn createContext();`, ["fetch", "pluginModule"]);
	return factory(fetch, {}) as WasmContext;
}

describe("Workerd generated wasm context", () => {
	it("omits ctx.wasm without wasm:execute", () => {
		expect(createContext([], () => undefined).wasm).toBeUndefined();
	});

	it("sends base64 module bytes to wasm/run and returns the result", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const context = createContext(["wasm:execute"], (url, init) => {
			calls.push({ url, body: JSON.parse(typeof init.body === "string" ? init.body : "null") });
			return Response.json({ result: { echoed: true } });
		});
		await expect(
			context.wasm!.run({ module: ECHO_MODULE, entry: "echo", input: { a: 1 }, sha256: "ab" }),
		).resolves.toEqual({ echoed: true });
		expect(calls).toEqual([
			{
				url: "http://bridge/wasm/run",
				body: { module: toBase64(ECHO_MODULE), entry: "echo", input: { a: 1 }, sha256: "ab" },
			},
		]);
	});

	it("rethrows bridge WASM errors with their code prefix", async () => {
		const context = createContext(["wasm:execute"], () =>
			Response.json(
				{
					error: {
						name: "WasmRunError",
						code: "WASM_TIMEOUT",
						message: "WASM_TIMEOUT: run exceeded 5000 ms",
					},
				},
				{ status: 400 },
			),
		);
		await expect(context.wasm!.run({ module: ECHO_MODULE, entry: "echo" })).rejects.toMatchObject({
			name: "WasmRunError",
			code: "WASM_TIMEOUT",
			message: "WASM_TIMEOUT: run exceeded 5000 ms",
		});
	});

	it("rejects non-byte modules before calling the bridge", async () => {
		const context = createContext(["wasm:execute"], () => {
			throw new Error("bridge must not be called");
		});
		await expect(context.wasm!.run({ module: [0, 97], entry: "echo" })).rejects.toMatchObject({
			code: "WASM_ABI_INVALID",
			message: "WASM_ABI_INVALID: module must be a Uint8Array",
		});
	});
});
