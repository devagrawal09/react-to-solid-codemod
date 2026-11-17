// analyze(source, filename) over lib/compiler-facts.wasm: oxc's React Compiler with its
// reactive analysis exposed. Works with any host whose compiled module has `instantiate()`
// returning `{ exports, memory: { write(ptr, string), readString(ptr, len), size() } }`.
// `write` stores UTF-8 and returns the bytes written; a UTF-16 unit is at most 3 UTF-8 bytes,
// so `length * 3` always fits.
//
// WASM memory only grows, and one large component can take the compiler past 2 GB (t3code's
// ChatView.tsx), so an instance that has grown past `maxMemoryBytes` is dropped after the call
// and the next call starts a fresh one. Instantiating takes well under a millisecond.
export function bindAnalyze(compiled, { maxMemoryBytes = 256 * 1024 * 1024 } = {}) {
  let instance = null;
  return function analyze(source, filename = "input.tsx") {
    instance ??= compiled.instantiate();
    const { exports: wasm, memory } = instance;
    const sourceCapacity = source.length * 3;
    const nameCapacity = filename.length * 3;
    const sourcePtr = wasm.alloc(sourceCapacity);
    const namePtr = wasm.alloc(nameCapacity);
    try {
      const sourceLen = memory.write(sourcePtr, source);
      const nameLen = memory.write(namePtr, filename);
      const resultLen = wasm.analyze_utf8(sourcePtr, sourceLen, namePtr, nameLen);
      return JSON.parse(memory.readString(wasm.result_ptr(), resultLen));
    } catch (error) {
      instance = null; // a trap leaves the instance's heap in an unknown state
      throw error;
    } finally {
      if (instance) {
        wasm.dealloc(sourcePtr, sourceCapacity);
        wasm.dealloc(namePtr, nameCapacity);
        if (memory.size() > maxMemoryBytes) instance = null;
      }
    }
  };
}
