import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'docs/**',
      'public/**',
      'data/**',
      'tools/build-city.mjs',
      // Легаси-модуль, не импортируется игрой (заменён cityWorld/tileManager в bootstrap).
      'src/world/tileManager.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Проект использует 0/1 как sentinel и числовые коды состояний —
      // строгое eqeqeq здесь мешает существующему коду.
      'eqeqeq': 'off',
      // В коде принят стиль «объявить let, инициализировать позже» — это не ошибка.
      'prefer-const': 'off',
    },
  },
  {
    files: ['tools/**/*.mjs', 'eslint.config.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
);
