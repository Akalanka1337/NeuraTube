/**
 * Static provider descriptions.
 *
 * Base URLs, auth shapes and wire formats only. Deliberately NO model IDs:
 * every adapter discovers those at runtime from the provider's own `/models`
 * endpoint. The brief listed `gpt-4o-mini`, `claude-sonnet-4-5`, `deepseek-chat`
 * and `meta/llama-3.1-70b-instruct`; catalogues moved before this milestone was
 * built, and at least one of those was already retired. Hardcoding an ID buys a
 * support ticket, not a default.
 *
 * `baseUrl` is user-overridable for every provider — self-hosted NIM needs it,
 * gateways and proxies need it, and it is the escape hatch if a provider moves
 * an endpoint before we can ship an update.
 */

import type { ProviderId, ProviderSpec } from './types';

export const PROVIDER_SPECS: Readonly<Record<ProviderId, ProviderSpec>> = Object.freeze({
  openai: {
    id: 'openai',
    label: 'OpenAI',
    wire: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'starts with sk-',
    requiresBrowserOptIn: false,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    wire: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    chatPath: '/messages',
    modelsPath: '/models',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'starts with sk-ant-',
    // Anthropic rejects browser-originated requests unless an explicit opt-in
    // header is present. See anthropic.ts.
    requiresBrowserOptIn: true,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    wire: 'openai',
    // DeepSeek's OpenAI-compatible surface is served from the bare host; the
    // /v1 segment is accepted but not required.
    defaultBaseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'starts with sk-',
    requiresBrowserOptIn: false,
  },
  'nvidia-nim': {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    wire: 'openai',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    keyUrl: 'https://build.nvidia.com',
    keyHint: 'starts with nvapi-',
    requiresBrowserOptIn: false,
  },
});

export function specFor(id: ProviderId): ProviderSpec {
  return PROVIDER_SPECS[id];
}

/**
 * Origins the extension needs host permissions for.
 *
 * Kept here so `build/manifest.mjs` and the runtime cannot drift; a unit test
 * asserts they agree. A user who overrides a base URL to a host outside this
 * list will get a request blocked by Chrome, which the options page explains.
 */
export const PROVIDER_ORIGINS: readonly string[] = [
  'https://api.openai.com/*',
  'https://api.anthropic.com/*',
  'https://api.deepseek.com/*',
  'https://integrate.api.nvidia.com/*',
];

/**
 * Join a base URL and a path without producing a double slash or dropping a
 * path prefix the user configured (e.g. a gateway at `https://gw/openai/v1`).
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}
