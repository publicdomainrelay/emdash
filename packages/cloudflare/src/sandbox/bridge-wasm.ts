import {
	generateWasmAbiRuntimeSource,
	prepareWasmRun,
	toWasmRunError,
	WASM_LIMITS,
	WasmRunError,
	type WasmRunRequest,
} from "emdash/internal/plugins/wasm";

import type { WorkerLoader } from "./types.js";

const CPU_LIMIT_RE = /exceeded CPU (?:time )?limit/i;

type WasmRunnerResult = { ok: true; output: string } | { ok: false; error: string };

interface WasmRunnerEntrypoint {
	run(entry: string, inputJson: string): Promise<WasmRunnerResult>;
}

let runnerSource: string | undefined;

export function generateWasmRunnerSource(): string {
	runnerSource ??= `import { WorkerEntrypoint } from "cloudflare:workers";
import compiled from "./module.wasm";

${generateWasmAbiRuntimeSource()}

export default class WasmRunner extends WorkerEntrypoint {
	async run(entry, inputJson) {
		try {
			return { ok: true, output: runWasmJsonAbi(compiled, entry, inputJson, WASM_LIMITS) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
}
`;
	return runnerSource;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function mapRunError(error: unknown): WasmRunError {
	const mapped = toWasmRunError(error);
	if (mapped.code === "WASM_TRAP" && CPU_LIMIT_RE.test(mapped.message)) {
		return new WasmRunError("WASM_TIMEOUT", "module exceeded its CPU time limit");
	}
	return mapped;
}

export async function sandboxWasmRun(
	request: WasmRunRequest,
	loader: WorkerLoader | undefined | null,
	wallTimeMs: number = WASM_LIMITS.wallTimeMs,
): Promise<unknown> {
	const prepared = await prepareWasmRun(request);
	if (!loader) {
		throw new WasmRunError(
			"WASM_UNAVAILABLE",
			"the worker has no worker_loaders binding named LOADER",
		);
	}
	const moduleBuffer = toArrayBuffer(prepared.module);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new WasmRunError("WASM_TIMEOUT", `module exceeded ${wallTimeMs}ms`));
		}, wallTimeMs);
	});
	try {
		const invocation = Promise.resolve().then(() => {
			const worker = loader.get(`emdash-wasm-${prepared.sha256}`, () => ({
				compatibilityDate: "2026-04-01",
				mainModule: "runner.js",
				modules: {
					"runner.js": { js: generateWasmRunnerSource() },
					"module.wasm": { wasm: moduleBuffer },
				},
				globalOutbound: null,
				limits: { cpuMs: WASM_LIMITS.wallTimeMs },
			}));
			return worker.getEntrypoint<WasmRunnerEntrypoint>().run(prepared.entry, prepared.inputJson);
		});
		const result = await Promise.race([invocation, timeout]);
		if (!result.ok) throw toWasmRunError(new Error(result.error));
		return JSON.parse(result.output);
	} catch (error) {
		throw mapRunError(error);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
