// The same analyze() under Node's WebAssembly, for tests and the Node CLI path.
import { readFileSync } from "node:fs";
import { bindAnalyze } from "./compiler-facts.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function loadAnalyze(path, options) {
  return bindAnalyze(compileNode(path), options);
}

// The compiled module, shaped like the engine's: `instantiate()` gives a fresh instance.
export function compileNode(path = new URL("../lib/compiler-facts.wasm", import.meta.url)) {
  const module = new WebAssembly.Module(readFileSync(path));
  const instantiate = () => {
    const { exports } = new WebAssembly.Instance(module);
    const bytes = () => new Uint8Array(exports.memory.buffer);
    return {
      exports,
      memory: {
        write: (ptr, text) => encoder.encodeInto(text, bytes().subarray(ptr)).written,
        readString: (ptr, len) => decoder.decode(bytes().subarray(ptr, ptr + len)),
        size: () => exports.memory.buffer.byteLength,
      },
    };
  };
  return { instantiate };
}
