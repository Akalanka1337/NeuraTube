import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * NeuraTube lint policy.
 *
 * Two rule groups here are load-bearing, not stylistic:
 *
 * 1. TRUSTED TYPES. Google has enforced Trusted Types on YouTube since
 *    2024-07-25 and explicitly warns that non-compliant extension DOM
 *    manipulation will be blocked by the browser. Any string-to-HTML sink
 *    (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
 *    `dangerouslySetInnerHTML`) throws a TypeError on a page we do not
 *    control. Preact's createElement path is safe; string HTML is not. These
 *    rules make the failure a lint error at author time instead of a blank
 *    panel in production.
 *
 * 2. CREDENTIAL STORAGE. `chrome.storage.sync` uploads to Google's servers
 *    and caps items at 8KB. API keys must only ever live in
 *    `chrome.storage.local`. Banned outright so it cannot slip in.
 */

const TRUSTED_TYPES_SINKS = [
  {
    property: 'innerHTML',
    message:
      'Trusted Types: assigning innerHTML throws on YouTube. Build nodes with Preact/createElement, or route through lib/trusted-types.ts.',
  },
  {
    property: 'outerHTML',
    message: 'Trusted Types: assigning outerHTML throws on YouTube. Build nodes instead.',
  },
  {
    property: 'insertAdjacentHTML',
    message: 'Trusted Types: insertAdjacentHTML throws on YouTube. Build nodes instead.',
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'artifacts/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'node_modules/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        __NEURATUBE_VERSION__: 'readonly',
        __DEV__: 'readonly',
      },
    },
    rules: {
      'no-restricted-properties': ['error', ...TRUSTED_TYPES_SINKS],
      'no-restricted-globals': [
        'error',
        { name: 'eval', message: 'MV3 forbids eval. There is no exception.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'Trusted Types: dangerouslySetInnerHTML throws on YouTube. Render children instead.',
        },
        {
          selector: "MemberExpression[object.property.name='storage'][property.name='sync']",
          message:
            'chrome.storage.sync uploads to Google and caps items at 8KB. Use storage.local.',
        },
        {
          selector: "CallExpression[callee.object.name='document'][callee.property.name='write']",
          message: 'Trusted Types: document.write throws on YouTube.',
        },
      ],

      // `any` requires a written justification per the project brief, so an
      // explicit disable comment (which demands a description) is the only
      // way through.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'off', // too noisy against untyped `chrome.*` edges
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // A leading underscore is the conventional marker for a parameter that a
      // signature requires but the implementation deliberately ignores — common
      // in test doubles and in wrappers around native APIs.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  // Build scripts and ESLint's own config are plain JavaScript and are not part
  // of the TypeScript program (allowJs is off), so type-aware rules cannot run
  // against them. Disable type checking for these files rather than pulling
  // .mjs into tsconfig, which would drag build tooling into the app's type
  // graph for no benefit.
  {
    files: ['build/**/*.mjs', 'scripts/**/*.mjs', 'eslint.config.js', '*.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
