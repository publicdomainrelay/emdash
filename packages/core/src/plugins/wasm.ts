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
const WASM_ERROR_MESSAGE = /^(WASM_[A-Z_]+): ([\s\S]*)$/;
const EMBEDDER_DISALLOWED = /disallowed by embedder/i;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
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
	if (WebAssembly.Module.imports(compiled).length > 0) {
		throw Object.assign(new Error("WASM_IMPORTS_NOT_ALLOWED: modules must not declare imports"), {
			name: "WasmRunError",
		});
	}
	const declared = new Map(
		WebAssembly.Module.exports(compiled).map((item) => [item.name, item.kind]),
	);
	if (
		declared.get("memory") !== "memory" ||
		declared.get("alloc") !== "function" ||
		declared.get(entry) !== "function"
	) {
		throw Object.assign(
			new Error(`WASM_ABI_INVALID: module must export memory, alloc and ${entry}`),
			{ name: "WasmRunError" },
		);
	}
	let instance: WebAssembly.Instance;
	try {
		instance = new WebAssembly.Instance(compiled, {});
	} catch (error) {
		throw Object.assign(
			new Error(`WASM_TRAP: ${error instanceof Error ? error.message : String(error)}`),
			{ name: "WasmRunError" },
		);
	}
	const memory = instance.exports.memory;
	const alloc = instance.exports.alloc;
	const run = instance.exports[entry];
	if (
		!(memory instanceof WebAssembly.Memory) ||
		typeof alloc !== "function" ||
		typeof run !== "function"
	) {
		throw Object.assign(
			new Error(`WASM_ABI_INVALID: module must export memory, alloc and ${entry}`),
			{
				name: "WasmRunError",
			},
		);
	}
	const pageBytes = 65536;
	const input = new TextEncoder().encode(inputJson);
	let packed: unknown;
	try {
		const pointer = Number(alloc(input.byteLength));
		new Uint8Array(memory.buffer, pointer, input.byteLength).set(input);
		packed = run(pointer, input.byteLength);
	} catch (error) {
		throw Object.assign(
			new Error(`WASM_TRAP: ${error instanceof Error ? error.message : String(error)}`),
			{ name: "WasmRunError" },
		);
	}
	if (memory.buffer.byteLength > limits.memoryPages * pageBytes) {
		throw Object.assign(new Error(`WASM_TOO_LARGE: memory exceeds ${limits.memoryPages} pages`), {
			name: "WasmRunError",
		});
	}
	if (typeof packed !== "bigint") {
		throw Object.assign(new Error(`WASM_ABI_INVALID: ${entry} must return i64`), {
			name: "WasmRunError",
		});
	}
	const outputPointer = Number(BigInt.asUintN(64, packed) >> 32n);
	const outputLength = Number(BigInt.asUintN(32, packed));
	if (outputLength > limits.outputBytes) {
		throw Object.assign(
			new Error(`WASM_OUTPUT_INVALID: output exceeds ${limits.outputBytes} bytes`),
			{ name: "WasmRunError" },
		);
	}
	if (outputPointer + outputLength > memory.buffer.byteLength) {
		throw Object.assign(new Error("WASM_OUTPUT_INVALID: output points outside memory"), {
			name: "WasmRunError",
		});
	}
	const output = new TextDecoder("utf-8", { fatal: true }).decode(
		new Uint8Array(memory.buffer, outputPointer, outputLength).slice(),
	);
	try {
		JSON.parse(output);
	} catch {
		throw Object.assign(new Error("WASM_OUTPUT_INVALID: output is not JSON"), {
			name: "WasmRunError",
		});
	}
	return output;
}

export function generateWasmAbiRuntimeSource(): string {
	return `const runWasmJsonAbi = (${runWasmJsonAbi.toString()});
const WASM_LIMITS = ${JSON.stringify(WASM_LIMITS)};`;
}

const WASM_ERROR_CODES: ReadonlySet<string> = new Set<WasmErrorCode>([
	"WASM_TOO_LARGE",
	"WASM_DIGEST_MISMATCH",
	"WASM_IMPORTS_NOT_ALLOWED",
	"WASM_ABI_INVALID",
	"WASM_TIMEOUT",
	"WASM_TRAP",
	"WASM_OUTPUT_INVALID",
	"WASM_UNAVAILABLE",
]);

const isWasmErrorCode = (value: string): value is WasmErrorCode => WASM_ERROR_CODES.has(value);

export function toWasmRunError(error: unknown): WasmRunError {
	if (error instanceof WasmRunError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const match = WASM_ERROR_MESSAGE.exec(message);
	const code = match?.[1];
	if (code && isWasmErrorCode(code)) return new WasmRunError(code, match?.[2] ?? "");
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
					compiled = await WebAssembly.compile(new Uint8Array(prepared.module));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (EMBEDDER_DISALLOWED.test(message))
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
