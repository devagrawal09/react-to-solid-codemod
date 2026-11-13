// The compiler's own bundled `debug` reads process.stderr.fd when it loads; jssg's process has no stderr.
const p = globalThis.process ?? (globalThis.process = { env: {} });
p.stderr ??= { fd: 2, isTTY: false, write() {} };
p.stdout ??= { fd: 1, isTTY: false, write() {} };
p.env ??= {};
globalThis.global ??= globalThis;
