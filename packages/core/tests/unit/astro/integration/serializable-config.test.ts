import { describe, expect, it } from "vitest";

import { buildSerializableConfig, emdash } from "../../../../src/astro/integration/index.js";

describe("buildSerializableConfig", () => {
	it("passes the update-check opt-out to the runtime config", () => {
		expect(buildSerializableConfig({ updateCheck: false }).updateCheck).toBe(false);
	});

	it("passes sandbox limits to the runtime config", () => {
		expect(buildSerializableConfig({ sandboxLimits: { subrequests: 200 } }).sandboxLimits).toEqual({
			subrequests: 200,
		});
	});
});

describe("updateCheck option", () => {
	it("rejects an invalid minimum release age during integration setup", () => {
		expect(() => emdash({ updateCheck: { minimumReleaseAge: "soon" } })).toThrow(
			/updateCheck\.minimumReleaseAge.*soon/,
		);
		expect(() => emdash({ updateCheck: { minimumReleaseAge: "48h" } })).not.toThrow();
	});
});

describe("sandboxLimits option", () => {
	it("rejects a non-positive limit during integration setup", () => {
		expect(() => emdash({ sandboxLimits: { subrequests: 0 } })).toThrow(
			/sandboxLimits\.subrequests/,
		);
		expect(() => emdash({ sandboxLimits: { subrequests: 200, cpuMs: 500 } })).not.toThrow();
	});
});
