// eslint.config.js — Baseline mínimo de lint para as funções serverless Node (api/).
// Escopo intencional: SÓ api/ (CommonJS/Node). Não cobre os HTML monolíticos nem as
// Edge Functions Deno (globais diferentes) — tratados separadamente no futuro.
// Foco em pegar bugs reais (variáveis/identificadores indefinidos), sem ruído de estilo.

const NODE_GLOBALS = {
  module: 'writable',
  exports: 'writable',
  require: 'readonly',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  AbortController: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

module.exports = [
  {
    files: ['api/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
    },
  },
];
