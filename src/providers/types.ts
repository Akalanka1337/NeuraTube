/**
 * Provider layer contracts.
 *
 * ONE DELIBERATE CHANGE FROM THE BRIEF'S INTERFACE.
 *
 * The brief specifies:
 *
 *   chat(messages: Message[], opts: ChatOpts): AsyncIterable<string>
 *
 * A stream of bare strings cannot carry token usage, and the cost meter is a
 * stated v1 feature ("real-time token counter, monthly-spend estimate"). Usage
 * arrives *inside* the stream — in a final usage-only chunk for OpenAI-shaped
 * providers, and cumulatively in `message_delta` for Anthropic — so a
 * string-only stream throws the numbers away and the meter would have to
 * re-tokenise client-side and guess.
 *
 * So `chat` yields a discriminated union instead. Text consumers filter for
 * `type: 'text'`; the meter listens for `type: 'usage'`. Same ergonomics, and
 * the data the product needs is no longer discarded.
 */

/** The four providers the extension supports. */
export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'nvidia-nim';

export const PROVIDER_IDS: readonly ProviderId[] = [
  'openai',
  'anthropic',
  'deepseek',
  'nvidia-nim',
];

/** How a provider's HTTP surface behaves. */
export type WireFormat =
  /** OpenAI `/chat/completions`. Also DeepSeek and NVIDIA NIM. */
  | 'openai'
  /** Anthropic `/v1/messages`, with its own event names and header set. */
  | 'anthropic';

export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  readonly role: Role;
  readonly content: string;
}

export interface ChatOpts {
  readonly model: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Aborts the request. Wired to the panel's cancel control in M5. */
  readonly signal?: AbortSignal;
}

/** Cumulative token counts for one request. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens served from the provider's prompt cache, when it reports them. */
  readonly cachedInputTokens?: number;
}

/**
 * One event from a chat stream.
 *
 * `usage` may arrive more than once (Anthropic reports it cumulatively as the
 * response grows); consumers must treat each as a replacement, not an increment.
 */
export type StreamEvent =
  | { readonly type: 'text'; readonly text: string }
  /**
   * Chain-of-thought tokens, which are NOT the answer.
   *
   * Reasoning models stream thinking in a separate field and their answer after
   * it. Dropping these produced a successful request with an empty output box —
   * the budget went entirely on thinking and `content` never came. Adapters emit
   * them so a caller can explain that rather than showing nothing.
   */
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'done'; readonly finishReason: string | null };

export interface ModelInfo {
  readonly id: string;
  /** Display name when the provider supplies one, else the id. */
  readonly label: string;
  /** Unix ms, when the provider reports a creation date. */
  readonly created: number | null;
}

export interface TestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Models discovered. Proves auth worked, not merely that the host resolved. */
  readonly modelCount: number | null;
  /** Redacted, user-facing failure description. */
  readonly error: string | null;
}

/**
 * A configured provider.
 *
 * Constructed per call from credentials read out of storage — never held in a
 * module-scope variable. The service worker is terminated after 30 seconds idle,
 * so a cached provider instance would be both a stale-key bug and pointless.
 */
export interface LLMProvider {
  readonly id: ProviderId;
  chat(messages: readonly Message[], opts: ChatOpts): AsyncIterable<StreamEvent>;
  /**
   * List models the key can access.
   *
   * Every provider exposes a `/models` endpoint, which is why NeuraTube hardcodes
   * no model IDs anywhere: catalogues now churn faster than any release cadence
   * we could ship on, and the brief's suggested IDs were already stale.
   */
  listModels(): Promise<readonly ModelInfo[]>;
  /**
   * Verify credentials and reachability.
   *
   * Implemented over `/models` rather than a one-token chat completion. Listing
   * models is free; a chat call bills the user every time they press a button
   * labelled "test". It proves the key is valid, the host is reachable and CORS
   * is satisfied — which is what the button claims.
   */
  testConnection(): Promise<TestResult>;
}

/** Static description of a provider's HTTP surface. */
export interface ProviderSpec {
  readonly id: ProviderId;
  readonly label: string;
  readonly wire: WireFormat;
  readonly defaultBaseUrl: string;
  /** Path appended to the base URL for chat. */
  readonly chatPath: string;
  /** Path appended to the base URL for model listing. */
  readonly modelsPath: string;
  /** Where the user gets a key. Shown in the options page. */
  readonly keyUrl: string;
  /** Shape of the key, for a client-side sanity check only. */
  readonly keyHint: string;
  /** Whether the provider is known to require an explicit browser opt-in header. */
  readonly requiresBrowserOptIn: boolean;
}

/** Per-provider user configuration, as persisted. */
export interface ProviderConfig {
  readonly apiKey: string;
  /** Empty until the user picks from the live model list. */
  readonly model: string;
  readonly enabled: boolean;
  /**
   * Overrides `defaultBaseUrl`.
   *
   * Exists for self-hosted NIM and for gateways/proxies. Also the escape hatch
   * if a provider moves its endpoint before we can ship an update.
   */
  readonly baseUrl: string;
}
