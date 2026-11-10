import solid from "eslint-plugin-solid/configs/v2";
import tsParser from "@typescript-eslint/parser";
export default [{ files: ["**/*.{ts,tsx}"], ignores: ["node_modules/**", "stubs/**"], ...solid, languageOptions: { ...(solid.languageOptions ?? {}), parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } } }];
