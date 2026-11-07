import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
	createInProcessWasmAccess,
	generateWasmAbiRuntimeSource,
	prepareWasmRun,
	sha256Hex,
} from "../../../src/plugins/wasm.js";

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

describe("wasm:execute in-process", () => {
	it("runs a module through the JSON ABI", async () => {
		const wasm = createInProcessWasmAccess();
		const input = { status: "🦋", nested: [1, 2, 3] };
		await expect(wasm.run({ module: ECHO_MODULE, entry: "echo", input })).resolves.toEqual(input);
	});

	it("verifies the module digest before running", async () => {
		const wasm = createInProcessWasmAccess();
		const sha256 = await sha256Hex(ECHO_MODULE);
		await expect(wasm.run({ module: ECHO_MODULE, entry: "echo", input: 1, sha256 })).resolves.toBe(
			1,
		);
		await expect(
			wasm.run({ module: ECHO_MODULE, entry: "echo", sha256: "0".repeat(64) }),
		).rejects.toThrow("WASM_DIGEST_MISMATCH");
	});

	it("rejects modules that declare imports", async () => {
		await expect(
			createInProcessWasmAccess().run({ module: IMPORTING_MODULE, entry: "echo" }),
		).rejects.toThrow("WASM_IMPORTS_NOT_ALLOWED");
	});

	it("rejects a missing entry export", async () => {
		await expect(
			createInProcessWasmAccess().run({ module: ECHO_MODULE, entry: "missing" }),
		).rejects.toThrow("WASM_ABI_INVALID");
	});

	it("rejects oversized modules and invalid entry names before compiling", async () => {
		await expect(
			prepareWasmRun({ module: new Uint8Array(4 * 1024 * 1024 + 1), entry: "echo" }),
		).rejects.toThrow("WASM_TOO_LARGE");
		await expect(prepareWasmRun({ module: ECHO_MODULE, entry: "../echo" })).rejects.toThrow(
			"WASM_ABI_INVALID",
		);
	});

	it("exposes the same runner as standalone source for isolates", async () => {
		const { runWasmJsonAbi, WASM_LIMITS } = runInNewContext(
			`${generateWasmAbiRuntimeSource()}\n({ runWasmJsonAbi, WASM_LIMITS });`,
			{ WebAssembly, TextEncoder, TextDecoder },
		);
		const compiled = await WebAssembly.compile(ECHO_MODULE);
		expect(JSON.parse(runWasmJsonAbi(compiled, "echo", '{"ok":true}', WASM_LIMITS))).toEqual({
			ok: true,
		});
	});
});
