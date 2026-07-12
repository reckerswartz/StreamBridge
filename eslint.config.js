import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        browser: "readonly",
        chrome: "readonly",
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        location: "readonly",
        URL: "readonly",
        Blob: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        TextDecoder: "readonly",
        ReadableStream: "readonly",
        HTMLVideoElement: "readonly",
        console: "readonly",
        process: "readonly",
        structuredClone: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    ignores: ["dist/**", "artifacts/**", ".tmp/**", "node_modules/**", "playwright-report/**", "test-results/**"]
  }
);
