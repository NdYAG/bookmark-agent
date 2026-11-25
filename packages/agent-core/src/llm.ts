import type { McpToolDefinition } from "./mcp-bridge.js";
import type { LlmContextMessage } from "./messages.js";

export interface LlmFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface LlmTurnInput {
  systemPrompt: string;
  messages: LlmContextMessage[];
  tools: McpToolDefinition[];
  toolHistory?: Array<{
    call: LlmFunctionCall;
    result: unknown;
    rawContentPart?: Record<string, unknown>;
  }>;
  onTextDelta?: (delta: string) => void;
}

export interface LlmTurnOutput {
  text: string;
  functionCalls: LlmFunctionCall[];
  rawModelParts?: Array<Record<string, unknown>>;
  firstTokenLatencyMs: number;
  totalLatencyMs: number;
}

export interface LlmProvider {
  readonly modelId: string;
  generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput>;
}

/**
 * Converts JSON Schema from MCP tool definition into Gemini API `parameters` schema
 * (stripping unsupported `$schema` / `additionalProperties` fields).
 */
function toGeminiSchema(schema: Record<string, any>): Record<string, any> {
  if (!schema || typeof schema !== "object") {
    return { type: "OBJECT", properties: {} };
  }
  const clean = (obj: any): any => {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(clean);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        k === "$schema" ||
        k === "additionalProperties" ||
        k === "default" ||
        k === "minLength" ||
        k === "maxLength"
      ) {
        continue;
      }
      if (k === "type" && typeof v === "string") {
        out.type = v.toUpperCase();
      } else {
        out[k] = clean(v);
      }
    }
    return out;
  };
  const res = clean(schema);
  if (!res.type) res.type = "OBJECT";
  return res;
}

export interface GeminiLlmProviderOptions {
  apiKey: string;
  modelId?: string;
  fallbackModelIds?: string[];
  baseUrl?: string;
}

/**
 * GeminiLlmProvider (pi-ai compatible Gemini v1beta provider):
 * Supports function calling (MCP tools), streaming text deltas, and automatic model fallback
 * (`gemini-3.6-flash` -> `gemini-3.5-flash` -> `gemini-3.1-flash-lite` -> `gemma-4-31b-it`).
 */
export class GeminiLlmProvider implements LlmProvider {
  readonly modelId: string;
  private readonly fallbackModels: string[];
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: GeminiLlmProviderOptions) {
    this.apiKey = opts.apiKey;
    this.modelId = opts.modelId || process.env.BOOKMARK_AGENT_CHAT_MODEL || "gemini-3.1-flash-lite";
    this.fallbackModels = opts.fallbackModelIds || [
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash-lite",
    ];
    this.baseUrl = opts.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  }

  async generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput> {
    const t0 = Date.now();
    const contents: Array<Record<string, any>> = [];

    for (const m of input.messages) {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }

    if (input.toolHistory && input.toolHistory.length > 0) {
      for (const th of input.toolHistory) {
        if (th.rawContentPart) {
          contents.push({
            role: "model",
            parts: [th.rawContentPart],
          });
        } else {
          contents.push({
            role: "model",
            parts: [
              {
                functionCall: {
                  name: th.call.name,
                  args: th.call.args,
                },
              },
            ],
          });
        }
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: th.call.name,
                response:
                  th.result && typeof th.result === "object"
                    ? th.result
                    : { result: th.result },
              },
            },
          ],
        });
      }
    }

    const functionDeclarations = input.tools.map((t) => {
      const schema = toGeminiSchema(t.inputSchema);
      const hasProps = schema.properties && Object.keys(schema.properties).length > 0;
      return {
        name: t.name,
        description: t.description,
        ...(hasProps ? { parameters: schema } : {}),
      };
    });

    const body: Record<string, any> = {
      systemInstruction: {
        parts: [{ text: input.systemPrompt }],
      },
      contents,
      generationConfig: {
        temperature: 0.2,
      },
    };

    if (functionDeclarations.length > 0) {
      body.tools = [{ functionDeclarations }];
    }

    const modelsToTry = Array.from(new Set([this.modelId, ...this.fallbackModels]));
    let lastError: any = null;

    for (const model of modelsToTry) {
      for (let retry = 0; retry < 2; retry++) {
        // Once text has reached the UI, retrying would show it twice: fail the turn instead
        let emitted = false;
        try {
          const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          if (!res.ok || !res.body) {
            const rawText = await res.text();
            if (res.status === 429 || res.status === 503) {
              lastError = new Error(`Gemini ${model} ${res.status}: ${rawText.slice(0, 240)}`);
              await new Promise((r) => setTimeout(r, 1200 * (retry + 1)));
              continue;
            }
            if (res.status === 404) {
              // Model name not available in region/tier, try next fallback
              lastError = new Error(`Model ${model} not found (404)`);
              break;
            }
            throw new Error(`Gemini API error (${res.status}): ${rawText.slice(0, 400)}`);
          }

          let firstTokenLatencyMs = 0;
          const parts: Array<Record<string, any>> = [];
          const functionCalls: LlmFunctionCall[] = [];
          let fullText = "";

          const onPart = (part: Record<string, any>) => {
            if (part.functionCall) {
              functionCalls.push({
                name: part.functionCall.name,
                args: (part.functionCall.args as Record<string, unknown>) || {},
              });
              parts.push(part);
              return;
            }
            if (typeof part.text !== "string" || part.thought) {
              if (Object.keys(part).length > 0) parts.push(part);
              return;
            }
            if (part.text) {
              if (!firstTokenLatencyMs) firstTokenLatencyMs = Date.now() - t0;
              fullText += part.text;
              emitted = true;
              input.onTextDelta?.(part.text);
            }
            // Merge consecutive plain text parts into one, as the non-streaming API returns them
            const prev = parts[parts.length - 1];
            const isPlain = (p: Record<string, any>) =>
              typeof p.text === "string" && Object.keys(p).every((k) => k === "text");
            if (prev && isPlain(prev) && isPlain(part)) prev.text += part.text;
            else parts.push({ ...part });
          };

          await readSseJson(res.body, (event) => {
            if (event?.error) {
              throw new Error(`Gemini stream error on ${model}: ${JSON.stringify(event.error).slice(0, 400)}`);
            }
            for (const part of event?.candidates?.[0]?.content?.parts || []) onPart(part);
          });

          return {
            text: fullText,
            functionCalls,
            rawModelParts: parts,
            firstTokenLatencyMs: firstTokenLatencyMs || Date.now() - t0,
            totalLatencyMs: Date.now() - t0,
          };
        } catch (err) {
          lastError = err;
          if (emitted) throw err;
        }
      }
    }

    throw lastError || new Error("All Gemini models failed");
  }
}

/** Parses a `text/event-stream` body and calls `onEvent` with each `data:` payload as JSON. */
async function readSseJson(body: ReadableStream<Uint8Array>, onEvent: (data: any) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const flush = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data && data !== "[DONE]") onEvent(JSON.parse(data));
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: RegExpExecArray | null;
    while ((sep = /\r?\n\r?\n/.exec(buf))) {
      flush(buf.slice(0, sep.index));
      buf = buf.slice(sep.index + sep[0].length);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) flush(buf);
}
