// ESLint flat config (ESLint v9+)
// Enforces TypeScript best practices and code quality standards for EZTest.
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    // Apply to all TypeScript source files
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // ── TypeScript rules ──
      ...tseslint.configs.recommended.rules,

      // Allow explicit any in cases where type-narrowing is impractical (e.g., Babel interop)
      '@typescript-eslint/no-explicit-any': 'warn',

      // Unused variables are bugs — error on them, but allow underscore-prefix to suppress
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Enforce consistent return types on functions that could be ambiguous
      '@typescript-eslint/explicit-function-return-type': 'off',

      // ── General JS rules ──
      'no-console': 'warn',         // Use the logger module, not console.log
      'no-debugger': 'error',
      'eqeqeq': ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  // Disable formatting rules that conflict with Prettier
  prettierConfig,
];
