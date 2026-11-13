function assert(v, m) { if (!v) throw new Error(m || "assertion failed"); }
assert.ok = assert; assert.strict = assert; assert.equal = (a, b, m) => assert(a == b, m); assert.strictEqual = (a, b, m) => assert(a === b, m);
module.exports = assert;
