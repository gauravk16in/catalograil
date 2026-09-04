import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Shared flat ESLint config. Consume from a package with:
 *   import config from '@catalograil/config/eslint';
 *   export default config;
 */
export default tseslint.config(
  { ignores: ['dist/**', '.next/**', 'cdk.out/**', 'coverage/**', '.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.es2023 } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Rule 13: money is bigint paise. Floats in money paths are a bug class.
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Amounts are bigint paise (rule 13). Never parse money as a float.',
        },
      ],
      eqeqeq: ['error', 'smart'],
    },
  },
  prettier,
);
