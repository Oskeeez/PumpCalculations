/** Thin LLM provider interface so the vendor can be swapped. One real implementation (Anthropic Messages API) and a scripted mock for tests. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface LlmTool {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens: number;
}

export interface LlmResponse {
  content: Block[];
  stopReason: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export interface AiSettings {
  apiKey: string;
  model: string;
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const SETTINGS_KEY = 'pipe-network-ai-settings';

export function loadAiSettings(): AiSettings {
  try {
    const t = localStorage.getItem(SETTINGS_KEY);
    if (t) {
      const s = JSON.parse(t) as Partial<AiSettings>;
      return { apiKey: typeof s.apiKey === 'string' ? s.apiKey : '', model: typeof s.model === 'string' && s.model ? s.model : DEFAULT_MODEL };
    }
  } catch {
    /* ignore */
  }
  return { apiKey: '', model: DEFAULT_MODEL };
}

export function saveAiSettings(s: AiSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Calls the Anthropic Messages API straight from the browser with the user's own key (kept in this browser only). */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  constructor(private readonly o: { apiKey: string; model: string; baseUrl?: string; fetchFn?: typeof fetch }) {}

  async complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    if (!this.o.apiKey.trim()) throw new Error('No API key set. Paste your Anthropic API key in the AI settings.');
    const f = this.o.fetchFn ?? fetch;
    const res = await f(`${this.o.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.o.apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: this.o.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages, ...(req.tools.length ? { tools: req.tools } : {}) }),
    });
    const text = await res.text();
    let body: { content?: Block[]; stop_reason?: string; error?: { message?: string } } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const hint = res.status === 401 ? ' Check your API key.' : res.status === 429 ? ' Rate limited; wait a moment and retry.' : '';
      throw new Error(`Anthropic API error ${res.status}: ${body.error?.message ?? text.slice(0, 200)}.${hint}`);
    }
    return { content: (body.content ?? []).filter((b) => b.type === 'text' || b.type === 'tool_use'), stopReason: body.stop_reason ?? 'end_turn' };
  }
}

/** Scripted provider for tests: `script` gets each request and the call index and returns the model's reply. */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  calls: LlmRequest[] = [];
  constructor(private readonly script: (req: LlmRequest, call: number) => LlmResponse | Promise<LlmResponse>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
    return this.script(req, this.calls.length - 1);
  }
}

export const text = (t: string): LlmResponse => ({ content: [{ type: 'text', text: t }], stopReason: 'end_turn' });
export const toolCalls = (...calls: { name: string; input: unknown }[]): LlmResponse => ({
  content: calls.map((c, i) => ({ type: 'tool_use' as const, id: `tu_${Math.random().toString(36).slice(2, 8)}_${i}`, name: c.name, input: c.input })),
  stopReason: 'tool_use',
});
