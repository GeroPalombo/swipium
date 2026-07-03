// ESLint flat config (v1-mvp-plan P1 §6). Posture: eslint + typescript-eslint recommended,
// tuned to the codebase's established patterns rather than switched off wholesale:
// - empty `catch {}` is an intentional best-effort idiom here → allowEmptyCatch;
// - existing `any`s are tolerated at warning level (new code should still avoid them);
// - unused vars are errors, with the `_`-prefix escape hatch the code already uses.
// Formatting is Prettier's job (.prettierrc) — no stylistic rules here.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.tgz'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Flags this repo's defensive `let x = fallback; try { x = await … } catch { return … }`
      // initializers as dead stores. All current hits are that idiom, not bugs — off for now.
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);
