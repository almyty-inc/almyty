import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import regexp from 'eslint-plugin-regexp';

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
  {
    // A regex that is quadratic or worse on hostile input fails the PR.
    // Every shape these two rules report was found holding the event loop
    // for seconds on 100 KB of a tool argument, a request body, an LLM
    // reply or an uploaded spec: `/X.*Y/`, `/\/+$/` on a run that does not
    // end the string, `\s*` beside `.+`. Linear replacements are in
    // common/security/linear-text.ts and strip-tags.ts; a trailing-run trim
    // takes the lookbehind form `/(?<!\/)\/+$/`. Tests may use anything.
    files: ['src/**/*.ts', 'ee/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/__tests__/**', 'src/test/**'],
    plugins: {
      regexp,
    },
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
    },
  },
];
