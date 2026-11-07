import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPlugin } from "../src/build/api.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("sandboxed plugin bundle resolution", () => {
	it("bundles a dependency's worker build instead of its Node.js build", async () => {
		const dir = await mkdtemp(join(tmpdir(), "emdash-plugin-conditions-"));
		temporaryDirectories.push(dir);
		const dependency = join(dir, "node_modules", "runtime-split");
		await mkdir(join(dir, "src"));
		await mkdir(dependency, { recursive: true });
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "@example/conditions", version: "1.0.0", type: "module" }),
		);
		await writeFile(
			join(dir, "emdash-plugin.jsonc"),
			JSON.stringify({
				slug: "conditions",
				publisher: "did:plc:example",
				license: "MIT",
				author: { name: "Example" },
				security: { email: "security@example.com" },
				capabilities: [],
			}),
		);
		await writeFile(
			join(dependency, "package.json"),
			JSON.stringify({
				name: "runtime-split",
				type: "module",
				exports: { ".": { browser: "./worker.js", node: "./node.js", default: "./node.js" } },
			}),
		);
		await writeFile(join(dependency, "worker.js"), 'export const runtime = () => "worker-build";');
		await writeFile(
			join(dependency, "node.js"),
			'import { randomUUID } from "node:crypto";\nexport const runtime = () => randomUUID();',
		);
		await writeFile(
			join(dir, "src/plugin.ts"),
			`import { runtime } from "runtime-split";
			export default { routes: { which: { handler: async () => runtime() } } };`,
		);

		const result = await buildPlugin({ dir });
		const bundle = await readFile(result.files.runtime, "utf8");

		expect(bundle).toContain("worker-build");
		expect(bundle).not.toContain("node:crypto");
	});
});
