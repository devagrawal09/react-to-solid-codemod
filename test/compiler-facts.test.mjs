import { describe, expect, it } from "vitest";
import { bindAnalyze } from "../src/compiler-facts.mjs";
import { compileNode, loadAnalyze } from "../src/compiler-facts-node.mjs";
import { extract } from "../src/extract.mjs";
import { decide } from "../src/decide.mjs";

const analyze = loadAnalyze();
const label = `function Label({ label }) {
  const text = label.toUpperCase();
  const fixed = 1;
  return <b>{text}{fixed}</b>;
}
`;

describe("compiler-facts.wasm", () => {
  it("reports the values of a component that derive from its props as reactive", () => {
    const [fn] = analyze(label, "Label.jsx").functions;
    expect(fn.reactive.named.filter((n) => n.reactive).map((n) => n.name).sort()).toEqual(["label", "text"]);
  });

  it("gives extract the same decisions as the Babel compiler on a component", () => {
    const decisions = (result) => JSON.stringify(decide(result).functions.map((f) => f.values.map((v) => [v.name, v.decision])));
    expect(decisions(extract(label, "Label.jsx", { analyze }))).toBe(decisions(extract(label, "Label.jsx")));
  });
});

it("the file after one that grew the compiler's memory past the cap gets a fresh instance", () => {
  const compiled = compileNode();
  let instances = 0;
  const analyzeCapped = bindAnalyze({ instantiate: () => (instances++, compiled.instantiate()) }, { maxMemoryBytes: 0 });
  analyzeCapped(label, "Label.jsx");
  analyzeCapped(label, "Label.jsx");
  expect(instances).toBe(2);
});
