---
"emdash": minor
---

Adds a `sandboxLimits` option for sandboxed plugin resource limits. It sets the per-invocation CPU time, subrequests, wall-clock time and memory that the sandbox runner applies, and unset fields keep the runner's defaults. On Cloudflare the default is 10 subrequests per invocation, which is too few for a plugin that makes several outbound requests:

```js
emdash({
	sandboxRunner: sandbox(),
	sandboxLimits: { cpuMs: 500, subrequests: 200 },
});
```
