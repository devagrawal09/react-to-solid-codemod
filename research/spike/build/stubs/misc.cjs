// Pulled in by debug/supports-color/import-meta-resolve, which this pass never runs.
module.exports = {
  isatty: () => false, deprecate: (f) => f, inspect: (v) => String(v), format: (...a) => a.join(" "),
  inherits: (c, p) => { Object.setPrototypeOf(c.prototype, p.prototype); }, types: {},
  platform: () => "linux", release: () => "", EOL: "\n", homedir: () => "/",
  getHeapStatistics: () => ({}), env: {}, argv: [], cwd: () => "/", version: "v22.0.0", versions: {},
};
