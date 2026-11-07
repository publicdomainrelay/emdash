import { prepareWasmRun, sha256Hex } from "emdash/internal/plugins/wasm";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "../../core/src/db/node-sqlite-compat.js";
import { createBridgeHandler } from "../src/sandbox/bridge-handler.js";
import { createWasmExecutor } from "../src/sandbox/wasm-executor.js";
import { ECHO_MODULE, IMPORTING_MODULE, SPIN_MODULE, toBase64 } from "./wasm-fixtures.js";

describe("wasm executor", () => {
	it("runs a module through the JSON ABI in a worker thread", async () => {
		const executor = createWasmExecutor();
		const input = { status: "🦋", nested: [1, 2, 3] };
		const prepared = await prepareWasmRun({ module: ECHO_MODULE, entry: "echo", input });
		const output = await executor.run(prepared);
		expect(JSON.parse(output)).toEqual(input);
		await expect(executor.run(prepared)).resolves.toBe(output);
	});

	it("rejects modules that declare imports", async () => {
		const executor = createWasmExecutor();
		const prepared = await prepareWasmRun({ module: IMPORTING_MODULE, entry: "echo" });
		await expect(executor.run(prepared)).rejects.toThrow(/^WASM_IMPORTS_NOT_ALLOWED: /);
	});

	it("rejects bytes that do not compile", async () => {
		const executor = createWasmExecutor();
		const prepared = await prepareWasmRun({ module: new Uint8Array([0, 1, 2]), entry: "echo" });
		await expect(executor.run(prepared)).rejects.toThrow(/^WASM_ABI_INVALID: /);
	});

	it("terminates a run that exceeds the wall time", async () => {
		const executor = createWasmExecutor({ wallTimeMs: 200 });
		const prepared = await prepareWasmRun({ module: SPIN_MODULE, entry: "spin" });
		const started = Date.now();
		await expect(executor.run(prepared)).rejects.toMatchObject({
			name: "WasmRunError",
			code: "WASM_TIMEOUT",
			message: expect.stringMatching(/^WASM_TIMEOUT: /),
		});
		expect(Date.now() - started).toBeLessThan(5000);
	});
});

describe("wasm/run bridge method", () => {
	let sqlite: Database;
	let db: Kysely<any>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqlite }) });
	});

	afterEach(async () => {
		await db.destroy();
		sqlite.close();
	});

	function handler(capabilities: string[]) {
		return createBridgeHandler({
			pluginId: "wasm-plugin",
			version: "1.0.0",
			capabilities,
			allowedHosts: [],
			storageCollections: [],
			db,
			emailSend: () => null,
			wasmExecutor: createWasmExecutor({ wallTimeMs: 200 }),
		});
	}

	function call(capabilities: string[], body: Record<string, unknown>) {
		return handler(capabilities)(
			new Request("http://bridge/wasm/run", { method: "POST", body: JSON.stringify(body) }),
		);
	}

	it("refuses wasm/run without wasm:execute", async () => {
		const response = await call([], { module: toBase64(ECHO_MODULE), entry: "echo", input: 1 });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Missing capability: wasm:execute" });
	});

	it("returns the parsed output when the digest matches", async () => {
		const response = await call(["wasm:execute"], {
			module: toBase64(ECHO_MODULE),
			entry: "echo",
			input: { ok: true },
			sha256: await sha256Hex(ECHO_MODULE),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ result: { ok: true } });
	});

	it("returns WASM error codes with their message prefix", async () => {
		const mismatch = await call(["wasm:execute"], {
			module: toBase64(ECHO_MODULE),
			entry: "echo",
			sha256: "0".repeat(64),
		});
		expect(mismatch.status).toBe(400);
		expect(await mismatch.json()).toEqual({
			error: {
				name: "WasmRunError",
				code: "WASM_DIGEST_MISMATCH",
				message: "WASM_DIGEST_MISMATCH: module digest does not match sha256",
			},
		});
		const timeout = await call(["wasm:execute"], { module: toBase64(SPIN_MODULE), entry: "spin" });
		expect(await timeout.json()).toMatchObject({
			error: { code: "WASM_TIMEOUT", message: expect.stringMatching(/^WASM_TIMEOUT: /) },
		});
	});

	it("rejects oversized and malformed module payloads before decoding", async () => {
		const oversized = await call(["wasm:execute"], {
			module: "A".repeat(Math.ceil((4 * 1024 * 1024) / 3) * 4 + 4),
			entry: "echo",
		});
		expect(await oversized.json()).toMatchObject({ error: { code: "WASM_TOO_LARGE" } });
		const malformed = await call(["wasm:execute"], { module: "not base64!", entry: "echo" });
		expect(await malformed.json()).toMatchObject({ error: { code: "WASM_ABI_INVALID" } });
	});
});
