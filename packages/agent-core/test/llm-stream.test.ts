import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiLlmProvider } from "../src/index.js";

/** Builds an SSE response whose bytes arrive in the given raw chunks. */
function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

const event = (parts: unknown[]) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts } }] })}\r\n\r\n`;

const input = (deltas: string[]) => ({
  systemPrompt: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
  onTextDelta: (d: string) => deltas.push(d),
});

afterEach(() => vi.unstubAllGlobals());

describe("GeminiLlmProvider streaming", () => {
  it("emits text deltas as SSE events arrive and returns merged parts", async () => {
    const e1 = event([{ text: "你好，" }]);
    const e2 = event([{ text: "这是流式" }]);
    const e3 = event([{ text: "输出。" }]);
    // Split one event across two network chunks
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      sseResponse([e1, e2.slice(0, 20), e2.slice(20) + e3]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    const out = await new GeminiLlmProvider({ apiKey: "k", modelId: "m" }).generateTurn(input(deltas));

    expect(String(fetchMock.mock.calls[0][0])).toContain("/models/m:streamGenerateContent?alt=sse&key=k");
    expect(deltas).toEqual(["你好，", "这是流式", "输出。"]);
    expect(out.text).toBe("你好，这是流式输出。");
    expect(out.rawModelParts).toEqual([{ text: "你好，这是流式输出。" }]);
  });

  it("collects function calls with their raw parts (thought signatures included)", async () => {
    const call = { functionCall: { name: "search", args: { query: "halftone" } }, thoughtSignature: "sig" };
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([event([call])])));
    const deltas: string[] = [];
    const out = await new GeminiLlmProvider({ apiKey: "k", modelId: "m" }).generateTurn(input(deltas));
    expect(deltas).toEqual([]);
    expect(out.functionCalls).toEqual([{ name: "search", args: { query: "halftone" } }]);
    expect(out.rawModelParts).toEqual([call]);
  });

  it("falls back to the next model on 404 but does not retry after text was shown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(sseResponse([event([{ text: "部分" }]), `data: {"error":{"code":500}}\r\n\r\n`]));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];
    const provider = new GeminiLlmProvider({ apiKey: "k", modelId: "a", fallbackModelIds: ["b"] });
    await expect(provider.generateTurn(input(deltas))).rejects.toThrow(/stream error on b/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deltas).toEqual(["部分"]);
  });
});
