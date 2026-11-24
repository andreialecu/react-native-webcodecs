// eslint.config.js
import wcandillon from "eslint-config-react-native-wcandillon";

export default [
  {
    ignores: ["node_modules/**", "example/**", ".yarn/**", "docs/**", "lib/**", "android/**", "ios/**", "nitrogen/**", "*.config.js"]
  },
  ...wcandillon,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    rules: {
      "no-bitwise": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-dupe-class-members": "off",
      "import/extensions": "off",
      "prettier/prettier": [
        "error",
        {
          "trailingComma": "all"
        }
      ]
    }
  }
];