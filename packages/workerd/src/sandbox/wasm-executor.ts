import { Worker, type ResourceLimits } from "node:worker_threads";

import {
	generateWasmAbiRuntimeSource,
	toWasmRunError,
	WASM_LIMITS,
	WasmRunError,
	type PreparedWasmRun,
} from "emdash/internal/plugins/wasm";

export interface WasmExecutorOptions {
	wallTimeMs?: number;
	cacheSize?: number;
	resourceLimits?: ResourceLimits;
}

export interface WasmExecutor {
	run(prepared: PreparedWasmRun): Promise<string>;
}

const DEFAULT_CACHE_SIZE = 32;

const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
	maxOldGenerationSizeMb: 64,
	maxYoungGenerationSizeMb: 16,
	codeRangeSizeMb: 16,
	stackSizeMb: 4,
};

const WORKER_SOURCE = `${generateWasmAbiRuntimeSource()}
const { parentPort } = require("node:worker_threads");
parentPort.once("message", ({ compiled, entry, inputJson }) => {
	try {
		parentPort.postMessage({ ok: true, output: runWasmJsonAbi(compiled, entry, inputJson, WASM_LIMITS) });
	} catch (error) {
		parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
	}
});
`;

type WorkerReply = { ok: true; output: string } | { ok: false; message: string };

function isWorkerReply(value: unknown): value is WorkerReply {
	if (value === null || typeof value !== "object") return false;
	if ("ok" in value && value.ok === true)
		return "output" in value && typeof value.output === "string";
	return "message" in value && typeof value.message === "string";
}

export function createWasmExecutor(options: WasmExecutorOptions = {}): WasmExecutor {
	const wallTimeMs = options.wallTimeMs ?? WASM_LIMITS.wallTimeMs;
	const cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
	const resourceLimits = options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
	const cache = new Map<string, Promise<WebAssembly.Module>>();

	function compile(prepared: PreparedWasmRun): Promise<WebAssembly.Module> {
		const cached = cache.get(prepared.sha256);
		if (cached) {
			cache.delete(prepared.sha256);
			cache.set(prepared.sha256, cached);
			return cached;
		}
		const pending = WebAssembly.compile(prepared.module.slice()).catch((error: unknown) => {
			cache.delete(prepared.sha256);
			throw new WasmRunError(
				"WASM_ABI_INVALID",
				error instanceof Error ? error.message : String(error),
			);
		});
		cache.set(prepared.sha256, pending);
		while (cache.size > cacheSize) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
		return pending;
	}

	function execute(compiled: WebAssembly.Module, prepared: PreparedWasmRun): Promise<string> {
		return new Promise((resolve, reject) => {
			const worker = new Worker(WORKER_SOURCE, { eval: true, resourceLimits });
			let settled = false;
			const timer = setTimeout(() => {
				finish(() => reject(new WasmRunError("WASM_TIMEOUT", `run exceeded ${wallTimeMs} ms`)));
			}, wallTimeMs);
			function finish(action: () => void): void {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				void worker.terminate();
				action();
			}
			worker.once("message", (reply: unknown) => {
				finish(() => {
					if (!isWorkerReply(reply)) {
						reject(new WasmRunError("WASM_OUTPUT_INVALID", "worker returned an invalid reply"));
					} else if (reply.ok) {
						resolve(reply.output);
					} else {
						reject(toWasmRunError(new Error(reply.message)));
					}
				});
			});
			worker.once("error", (error) => finish(() => reject(toWasmRunError(error))));
			worker.once("exit", (code) => {
				finish(() => reject(new WasmRunError("WASM_TRAP", `worker exited with code ${code}`)));
			});
			worker.postMessage({ compiled, entry: prepared.entry, inputJson: prepared.inputJson }, []);
		});
	}

	return {
		async run(prepared) {
			try {
				return await execute(await compile(prepared), prepared);
			} catch (error) {
				throw toWasmRunError(error);
			}
		},
	};
}

let defaultExecutor: WasmExecutor | null = null;

export function getDefaultWasmExecutor(): WasmExecutor {
	defaultExecutor ??= createWasmExecutor();
	return defaultExecutor;
}
