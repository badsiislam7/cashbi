// Flat config for ESLint 9. `dist/` and `node_modules/` are ignored. The
// security-sensitive hard rules (no secrets, no hardcoded peers) live in the
// source-tree review process and test/security.test.ts, not the linter.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "data/**", "*.md"],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off", // RPC boundary payloads are dynamic
    },
  },
);
