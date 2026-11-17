module.exports = { createRequire: () => (id) => { throw new Error(`require(${id}) is not available in this bundle`); }, builtinModules: [] };
