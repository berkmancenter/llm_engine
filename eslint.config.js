/* eslint-disable import/no-extraneous-dependencies */
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import jestPlugin from 'eslint-plugin-jest'
import securityPlugin from 'eslint-plugin-security'
import prettierPlugin from 'eslint-plugin-prettier'
import eslintConfigPrettier from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import globals from 'globals'
import { FlatCompat } from '@eslint/eslintrc'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import { fileURLToPath } from 'url'
import path from 'path'

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname // Optional, default to process.cwd()
})

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  securityPlugin.configs.recommended,
  ...compat.extends('eslint-config-airbnb-base'),
  eslintConfigPrettier, // prettier needs to be last to override default rules like required semicolons
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json'
      },
      globals: { ...globals.node }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      security: securityPlugin,
      prettier: prettierPlugin,
      import: importPlugin
    },
    ignores: ['dist/**', 'node_modules/**'],
    rules: {
      'import/extensions': 'off',
      'no-console': 'error',
      'func-names': 'off',
      'no-underscore-dangle': 'off',
      'consistent-return': 'off',
      'security/detect-object-injection': 'off',
      'no-plusplus': 'off',
      'no-await-in-loop': 'off',
      'no-continue': 'off',
      'no-restricted-syntax': ['off', 'ForOfStatement'],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      'no-return-await': 'off'
    },
    settings: {
      'import/resolver': {
        typescript: createTypeScriptImportResolver()
      }
    }
  },
  {
    // Test file override
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest
      }
    },
    plugins: { jest: jestPlugin },
    rules: {
      'jest/no-disabled-tests': 'warn',
      'jest/no-focused-tests': 'error',
      'jest/no-identical-title': 'error',
      'jest/prefer-to-have-length': 'warn',
      'jest/valid-expect': 'error',
      'jest/expect-expect': 'off'
    }
  }
)
