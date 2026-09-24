import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// Flat config for ESLint 10, kept in step with frontend/eslint.config.mjs:
// the TypeScript parser, the plugin's recommended rules, and no type-aware
// linting so it stays fast enough to gate CI.
export default [
  {
    ignores: ['dist/**', 'dist-ee/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts', 'ee/**/*.ts', 'test/**/*.ts'],
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // The same relaxations the frontend config makes: the codebase predates
      // enforced linting and these are opt-in cleanups, not gate failures.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      // Worth seeing, not worth failing CI over: `Function` as a type and
      // `const self = this` in callback-heavy code.
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      // Dead imports and variables are the one rule enforced as an error.
      // Prefix with `_` to keep a positional parameter or an ignored value.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
];
