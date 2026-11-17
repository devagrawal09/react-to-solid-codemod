// analyze() for jssg transforms: the engine instantiates the .wasm the transform imports.
import compilerFacts from "../lib/compiler-facts.wasm";
import { bindAnalyze } from "./compiler-facts.mjs";

export const analyze = bindAnalyze(compilerFacts);
