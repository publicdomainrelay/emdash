export const WASM_ABI = "emdash-wasm-json-v1";

export const WASM_LIMITS = Object.freeze({
	moduleBytes: 4 * 1024 * 1024,
	inputBytes: 1024 * 1024,
	outputBytes: 1024 * 1024,
	memoryPages: 1024,
	wallTimeMs: 5000,
});

export type WasmErrorCode =
	| "WASM_TOO_LARGE"
	| "WASM_DIGEST_MISMATCH"
	| "WASM_IMPORTS_NOT_ALLOWED"
	| "WASM_ABI_INVALID"
	| "WASM_TIMEOUT"
	| "WASM_TRAP"
	| "WASM_OUTPUT_INVALID"
	| "WASM_UNAVAILABLE";

export class WasmRunError extends Error {
	readonly code: WasmErrorCode;

	constructor(code: WasmErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "WasmRunError";
		this.code = code;
	}
}

export interface WasmRunRequest {
	module: Uint8Array;
	entry: string;
	input?: unknown;
	sha256?: string;
}

export interface PreparedWasmRun {
	module: Uint8Array;
	entry: string;
	inputJson: string;
	sha256: string;
}

const ENTRY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareWasmRun(request: WasmRunRequest): Promise<PreparedWasmRun> {
	if (!(request.module instanceof Uint8Array)) {
		throw new WasmRunError("WASM_ABI_INVALID", "module must be a Uint8Array");
	}
	if (request.module.byteLength > WASM_LIMITS.moduleBytes) {
		throw new WasmRunError("WASM_TOO_LARGE", `module exceeds ${WASM_LIMITS.moduleBytes} bytes`);
	}
	if (typeof request.entry !== "string" || !ENTRY_PATTERN.test(request.entry)) {
		throw new WasmRunError("WASM_ABI_INVALID", "entry must be an export name");
	}
	const inputJson = JSON.stringify(request.input ?? null);
	if (new TextEncoder().encode(inputJson).byteLength > WASM_LIMITS.inputBytes) {
		throw new WasmRunError("WASM_TOO_LARGE", `input exceeds ${WASM_LIMITS.inputBytes} bytes`);
	}
	const sha256 = await sha256Hex(request.module);
	if (request.sha256 !== undefined) {
		const expected = String(request.sha256).toLowerCase();
		if (!SHA256_PATTERN.test(expected) || expected !== sha256) {
			throw new WasmRunError("WASM_DIGEST_MISMATCH", "module digest does not match sha256");
		}
	}
	return { module: request.module, entry: request.entry, inputJson, sha256 };
}

export function runWasmJsonAbi(
	compiled: WebAssembly.Module,
	entry: string,
	inputJson: string,
	limits: { memoryPages: number; outputBytes: number },
): string {
	const fail = (code: string, message: string): never => {
		const error = new Error(`${code}: ${message}`);
		error.name = "WasmRunError";
		throw error;
	};
	if (WebAssembly.Module.imports(compiled).length > 0) {
		fail("WASM_IMPORTS_NOT_ALLOWED", "modules must not declare imports");
	}
	const declared = new Map(
		WebAssembly.Module.exports(compiled).map((item) => [item.name, item.kind]),
	);
	if (
		declared.get("memory") !== "memory" ||
		declared.get("alloc") !== "function" ||
		declared.get(entry) !== "function"
	) {
		fail("WASM_ABI_INVALID", `module must export memory, alloc and ${entry}`);
	}
	let instance: WebAssembly.Instance;
	try {
		instance = new WebAssembly.Instance(compiled, {});
	} catch (error) {
		return fail("WASM_TRAP", error instanceof Error ? error.message : String(error));
	}
	const exports = instance.exports as Record<string, unknown>;
	const memory = exports.memory as WebAssembly.Memory;
	const alloc = exports.alloc as (length: number) => number;
	const run = exports[entry] as (pointer: number, length: number) => bigint;
	const pageBytes = 65536;
	const input = new TextEncoder().encode(inputJson);
	let packed: bigint;
	try {
		const pointer = alloc(input.byteLength);
		new Uint8Array(memory.buffer, pointer, input.byteLength).set(input);
		packed = run(pointer, input.byteLength);
	} catch (error) {
		return fail("WASM_TRAP", error instanceof Error ? error.message : String(error));
	}
	if (memory.buffer.byteLength > limits.memoryPages * pageBytes) {
		fail("WASM_TOO_LARGE", `memory exceeds ${limits.memoryPages} pages`);
	}
	if (typeof packed !== "bigint") {
		fail("WASM_ABI_INVALID", `${entry} must return i64`);
	}
	const outputPointer = Number(BigInt.asUintN(64, packed) >> 32n);
	const outputLength = Number(BigInt.asUintN(32, packed));
	if (outputLength > limits.outputBytes) {
		fail("WASM_OUTPUT_INVALID", `output exceeds ${limits.outputBytes} bytes`);
	}
	if (outputPointer + outputLength > memory.buffer.byteLength) {
		fail("WASM_OUTPUT_INVALID", "output points outside memory");
	}
	const output = new TextDecoder("utf-8", { fatal: true }).decode(
		new Uint8Array(memory.buffer, outputPointer, outputLength).slice(),
	);
	try {
		JSON.parse(output);
	} catch {
		fail("WASM_OUTPUT_INVALID", "output is not JSON");
	}
	return output;
}

export function generateWasmAbiRuntimeSource(): string {
	return `const runWasmJsonAbi = (${runWasmJsonAbi.toString()});
const WASM_LIMITS = ${JSON.stringify(WASM_LIMITS)};`;
}

export function toWasmRunError(error: unknown): WasmRunError {
	if (error instanceof WasmRunError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const match = /^(WASM_[A-Z_]+): ([\s\S]*)$/.exec(message);
	if (match) return new WasmRunError(match[1] as WasmErrorCode, match[2] ?? "");
	return new WasmRunError("WASM_TRAP", message);
}

export interface WasmAccess {
	run(request: WasmRunRequest): Promise<unknown>;
}

export function createInProcessWasmAccess(): WasmAccess {
	const cache = new Map<string, WebAssembly.Module>();
	return {
		async run(request) {
			const prepared = await prepareWasmRun(request);
			let compiled = cache.get(prepared.sha256);
			if (!compiled) {
				try {
					compiled = await WebAssembly.compile(prepared.module as Uint8Array<ArrayBuffer>);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (/disallowed by embedder/i.test(message))
						throw new WasmRunError("WASM_UNAVAILABLE", message);
					throw new WasmRunError("WASM_ABI_INVALID", message);
				}
				cache.set(prepared.sha256, compiled);
			}
			try {
				return JSON.parse(
					runWasmJsonAbi(compiled, prepared.entry, prepared.inputJson, WASM_LIMITS),
				);
			} catch (error) {
				throw toWasmRunError(error);
			}
		},
	};
}
