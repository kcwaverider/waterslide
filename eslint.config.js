import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/**", "**/node_modules/**", ".waterslide/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
  },
  {
    // Handoff §4 / §4.2: core/ must not import from packs/. npm workspaces and
    // TypeScript project references do not enforce this; this rule does.
    files: ["core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@waterslide/pack-*",
                "@waterslide/pack-*/**",
                "**/packs/**",
              ],
              message:
                "core/ must not import from packs/ (handoff §4). Put the logic behind the pack interface instead.",
            },
          ],
        },
      ],
    },
  },
);
