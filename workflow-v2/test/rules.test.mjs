import { expect, it } from "vitest";
import { parse, Lang } from "@ast-grep/napi";
import { transform } from "../rules/mechanical.mjs";

const convert = (code) => transform(code, { parse, Lang }).code;

it("a loop variable that shadows a signal is not read as the signal", () => {
  const code = `function C() { const [size, setSize] = useState(0); const out = []; for (const size of [1, 2]) out.push(size); return <p onClick={() => setSize(1)}>{size}</p>; }`;
  expect(convert(code)).toContain("for (const size of [1, 2]) out.push(size);");
});

it("a catch parameter that shadows a destructured prop is not read as the prop", () => {
  const code = `function C({ error, onError }) { const go = () => { try { run(); } catch (error) { onError(error); } }; return <p onClick={go}>{error}</p>; }`;
  expect(convert(code)).toContain("catch (error) { props.onError(error); }");
});

it("a const in a nested block that shadows a destructured prop is not read as the prop", () => {
  const code = `function C({ name }) { const pick = () => { const name = "x"; return name; }; return <p onClick={pick}>{name}</p>; }`;
  expect(convert(code)).toContain(`const name = "x"; return name;`);
});
