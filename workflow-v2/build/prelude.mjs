// What the compiler and Babel read from Node's globals and jssg's process lacks: the compiler's
// bundled `debug` reads process.stderr.fd when it loads, @babel/core reads process.versions.node,
// and the workflow's own isolate has no process at all.
const p = globalThis.process ?? (globalThis.process = { env: {} });
p.stderr ??= { fd: 2, isTTY: false, write() {} };
p.stdout ??= { fd: 1, isTTY: false, write() {} };
p.env ??= {};
p.versions ??= { node: "22.12.0" };
globalThis.global ??= globalThis;
