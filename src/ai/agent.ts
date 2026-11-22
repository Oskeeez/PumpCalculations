/** The tool-use loop: ask the model, run its tool calls through the validated tool layer, feed results back, until it stops or a limit is hit. */
import type { Block, LlmMessage, LlmProvider } from './llm';
import { executeTool, TOOL_DEFS, type ToolDef, type Workspace } from './tools';

export interface AgentResult {
  text: string;
  messages: LlmMessage[];
  turns: number;
  stoppedBy: 'done' | 'turn-limit' | 'tool-limit' | 'aborted';
}

export interface AgentOptions {
  provider: LlmProvider;
  ws: Workspace;
  system: string;
  /** Prior conversation, then the new user message is appended. */
  history?: LlmMessage[];
  user: string;
  tools?: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called after each model turn with the assistant text so far. */
  onText?: (t: string) => void;
}

const clip = (s: string, n = 14000) => (s.length > n ? `${s.slice(0, n)}…[truncated ${s.length - n} chars; ask for a narrower scope]` : s);

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const { ws } = o;
  const tools = (o.tools ?? TOOL_DEFS).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const messages: LlmMessage[] = [...(o.history ?? []), { role: 'user', content: [{ type: 'text', text: o.user }] }];
  let finalText = '';
  for (let turn = 1; turn <= ws.limits.maxTurns; turn++) {
    if (o.signal?.aborted) return { text: finalText, messages, turns: turn - 1, stoppedBy: 'aborted' };
    if (ws.usage.toolCalls >= ws.limits.maxToolCalls) {
      ws.log.push({ t: new Date().toISOString(), kind: 'limit', note: `Stopped: tool-call limit (${ws.limits.maxToolCalls}) reached.` });
      return { text: finalText, messages, turns: turn - 1, stoppedBy: 'tool-limit' };
    }
    const res = await o.provider.complete({ system: o.system, messages, tools, maxTokens: o.maxTokens ?? 4096 }, o.signal);
    messages.push({ role: 'assistant', content: res.content });
    const said = res.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (said) finalText = said;
    ws.log.push({ t: new Date().toISOString(), kind: 'llm', note: `turn ${turn}: ${said.slice(0, 300)}`, ok: true });
    o.onText?.(finalText);
    const uses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) return { text: finalText, messages, turns: turn, stoppedBy: 'done' };
    const results: Block[] = uses.map((u) => {
      const r = executeTool(ws, u.name, u.input);
      return { type: 'tool_result', tool_use_id: u.id, content: clip(JSON.stringify(r.ok ? r.data : { error: r.error })), is_error: !r.ok };
    });
    messages.push({ role: 'user', content: results });
  }
  ws.log.push({ t: new Date().toISOString(), kind: 'limit', note: `Stopped: turn limit (${ws.limits.maxTurns}) reached.` });
  return { text: finalText, messages, turns: ws.limits.maxTurns, stoppedBy: 'turn-limit' };
}
