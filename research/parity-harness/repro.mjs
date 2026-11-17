import { createRequire } from "node:module"; import { transformSync } from "oxc-transform-react";
const req = createRequire("/home/user/src/react-to-solid-codemod/package.json"); const babel = req("@babel/core");
const code = process.argv[2];
const b = (p) => babel.transformSync(code, { filename: "x.tsx", babelrc: false, configFile: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[p, { panicThreshold: "none" }]] }).code;
console.log("--- babel 1.0.0\n" + b(req("babel-plugin-react-compiler")));
console.log("--- babel exp May 2026\n" + b(createRequire("/home/user/src/harness/exp/package.json")("babel-plugin-react-compiler")));
console.log("--- oxc 0.158\n" + transformSync("x.tsx", code, { jsx: "preserve", typescript: {}, reactCompiler: { panicThreshold: "none" } }).code);
