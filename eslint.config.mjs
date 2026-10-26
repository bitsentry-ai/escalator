import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { readabilityConfigs } from "./scripts/eslint/readability-rules.mjs";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.test-dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...readabilityConfigs(),
);
