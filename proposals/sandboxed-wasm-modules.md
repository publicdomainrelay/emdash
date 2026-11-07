# Sandboxed WebAssembly modules for plugins

Status: draft (prototype in publicdomainrelay/emdash, branch `wasm-blob-sandbox`)

## Summary

Add a `wasm:execute` capability that gives sandboxed plugins `ctx.wasm.run()`. The plugin supplies WebAssembly bytes, an entry export and JSON input. The host runs the module in its own isolate with no imports, no network, and bounded time and memory, and returns JSON output.

## Problem and user case

Plugin isolates cannot compile WebAssembly. Both runners refuse runtime compilation with `CompileError: Wasm code generation disallowed by embedder`, and plugin bundles carry only JavaScript. A plugin that loads code at runtime cannot use WebAssembly at all. An example is an integration whose logic is published as an atproto blob next to its OAuth client metadata.

The motivating case is an integrations plugin. It holds per-user atproto OAuth sessions, and it runs small, third-party, untrusted modules that know one app's lexicons. A module turns user input into the XRPC calls to make. The plugin makes those calls with the session it manages, so a module never sees a token.

## Example

```jsonc
{
	"capabilities": ["wasm:execute", "network:request:unrestricted"]
}
```

```ts
const bytes = new Uint8Array(await (await ctx.http.fetch(blobUrl)).arrayBuffer());
const output = await ctx.wasm.run({
	module: bytes,
	sha256: expectedDigestHex,
	entry: "set_status",
	input: { status: "🦋", now: new Date().toISOString(), did },
});
```

## Goals

- Run plugin-supplied WebAssembly in sandboxed plugins on Cloudflare Workers and Node.js.
- Give modules no authority beyond computation. The host provides no imports, no network, no storage and no clock.
- Bound each run by module size, input and output size, memory and wall time.
- Keep the plugin API identical across runners.

## Non-goals

- WASI, host imports, or callbacks from modules into `ctx`.
- Streaming input or output.
- Bundling `.wasm` files in registry tarballs. Plugins load bytes at runtime from wherever they choose.

## Detailed design

### Capability and context

`wasm:execute` is a new capability. When it is declared, `ctx.wasm` is populated:

```ts
interface WasmRunRequest {
	module: Uint8Array;
	entry: string;
	input?: unknown;
	sha256?: string;
}

interface WasmAccess {
	run(request: WasmRunRequest): Promise<unknown>;
}
```

`sha256`, when present, is the lowercase hex SHA-256 of `module`. The host verifies it before compiling. Plugins that load content-addressed bytes, such as atproto blobs, pass the digest from the CID.

### Module ABI: `emdash-wasm-json-v1`

- The module imports nothing. A module with any import is rejected with `WASM_IMPORTS_NOT_ALLOWED`.
- It exports `memory`, `alloc(len: i32) -> i32`, and the entry function `(ptr: i32, len: i32) -> i64`.
- The host writes the UTF-8 JSON encoding of `input` (or `null`) into memory returned by `alloc`, and calls the entry function with that pointer and length.
- The entry returns `(out_ptr << 32) | out_len`, which points at UTF-8 JSON in `memory`. The host decodes and parses it as the result.
- A missing export or a wrong signature fails with `WASM_ABI_INVALID`.

### Limits

| Limit | Value |
| --- | --- |
| Module size | 4 MiB |
| Input JSON | 1 MiB |
| Output JSON | 1 MiB |
| Linear memory | 64 MiB (1024 pages) |
| Wall time per run | 5 s |

### Runners

- **Node.js** (`@emdash-cms/sandbox-workerd`, both the workerd runner and the Miniflare dev runner): the bridge method `wasm/run` receives `{ module: base64, entry, input, sha256? }`. The host compiles once per digest and caches the compiled `WebAssembly.Module`. Each run happens in a `node:worker_threads` worker with `resourceLimits`, which is terminated when the wall time expires.
- **Cloudflare Workers** (`@emdash-cms/cloudflare`): `PluginBridge.wasmRun()` loads a Dynamic Worker keyed by digest through the `LOADER` binding. Its modules are a small runner script and `module.wasm` (`{ wasm: bytes }`), with `globalOutbound: null`. The runner instantiates the precompiled module the embedder provides, so no runtime code generation is needed, and returns the parsed output over RPC.
- **In-process plugins** (`plugins: []` or `sandbox: false`): `ctx.wasm.run` uses the same ABI in the host process on Node.js. It throws `WASM_UNAVAILABLE` where the platform forbids compilation.

### Errors

Runs reject with an `Error` whose message starts with a stable code: `WASM_TOO_LARGE`, `WASM_DIGEST_MISMATCH`, `WASM_IMPORTS_NOT_ALLOWED`, `WASM_ABI_INVALID`, `WASM_TIMEOUT`, `WASM_TRAP`, `WASM_OUTPUT_INVALID`, or `WASM_UNAVAILABLE`.

### Loading modules from atproto blobs (plugin-level convention)

This part is not core API. It is how the prototype integrations plugin uses the capability.

- The record `com.publicdomainrelay.temp.wasm.module` holds `name`, a `module` blob (`application/wasm`), `abi: "emdash-wasm-json-v1"`, a strong reference to the `com.publicdomainrelay.temp.oauth.clientMetadata` record whose session it uses, and a list of `actions` (`entry` and `label`).
- The plugin fetches the blob with `com.atproto.sync.getBlob`, checks the CID's SHA-256 multihash, and passes that digest as `sha256`.
- The module returns `{ "calls": [{ "nsid": "...", "params": {}, "input": {} }], "next": "...", "state": {}, "result": {} }`. The plugin makes each call with the user's session for that client metadata record. The authorization server already limits that session to the record's scopes. The record may also list the NSIDs the module may call.
- When `next` names another export, the plugin runs it with the call results and the returned `state`. This is how a module reads before it writes without host functions. Each result is `{ nsid, ok, output | error }`. The prototype caps a run at 8 rounds and 25 calls.
- Besides the signed-in browser session, the prototype accepts atproto service auth for `com.publicdomainrelay.temp.wasm.run`, so a user's PDS can trigger a run through `atproto-proxy`. The plugin verifies the JWT itself, because sandboxed routes never see `Authorization`.

## Compatibility and migration

Additive. Plugins that do not declare `wasm:execute` are unaffected. Hosts without support reject the capability at install time like any unknown capability.

## Security and privacy

- A module with no imports cannot reach the network, storage, secrets or `ctx`. It can only compute on its input.
- Modules run outside the plugin's isolate: in a separate Dynamic Worker on Cloudflare, or in a separate worker thread on Node.js, under the limits above.
- Digest verification ties a run to content-addressed bytes, so a compromised blob host cannot swap the module.
- Consent: `wasm:execute` appears in the install dialog as "Run WebAssembly modules the plugin loads, without network or storage access".

## Performance

The compile cache is keyed by digest. On Cloudflare, Dynamic Workers keyed by digest stay warm between runs. No query is added to any route.

## Failure handling

Each failure maps to a stable code. A timed-out Node worker is terminated and replaced. Plugins decide how to surface failures to users.

## Verification

- Unit tests of the ABI codec and limit checks in each runner package.
- A runner conformance test that executes a tiny no-import module (an `add` export wrapped in the JSON ABI) on the Worker Loader test host and on the workerd runner.
- An end-to-end prototype: a Rust Statusphere module stored as a blob in an atproto repo, run by the integrations plugin to set a status with a user's session.

## Rollout and implementation

1. `plugin-types` and `core`: capability, description, `WasmAccess` types, in-process implementation.
2. `sandbox-workerd`: bridge method, worker-thread executor, wrapper `ctx.wasm`.
3. `cloudflare`: `PluginBridge.wasmRun`, Dynamic Worker runner, wrapper `ctx.wasm`.
4. `plugin-cli` and `plugin-test`: accept the capability and run it in tests.

## Alternatives

- **Bundle `.wasm` modules in plugin tarballs.** This works for plugin-owned code but not for modules chosen at runtime, which is the motivating case.
- **Compile WebAssembly to JavaScript with `wasm2js`.** This runs today but is slow, large, and capped by the 128 KB bundle file limit.
- **External WebAssembly service called over `ctx.http`.** This needs another deployment and moves trust outside the site.

## Drawbacks

- New host code on two runners, plus a Dynamic Worker per distinct module on Cloudflare.
- JSON-only I/O costs serialization for binary-heavy work.

## Open questions

- Should modules get a fixed set of host functions (for example a clock, or a controlled `fetch`)? This draft says no. Rounds driven by the plugin cover read-before-write without them. A synchronous `fetch` import would need JSPI or Asyncify on Workers.
- Should limits be configurable per site?
