import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { AgentRuntime } from "./runtime.js";

// Electron's Node 22 gives each resolved address only 250 ms to connect before moving on, so on
// slower links every Gemini address times out and fetch fails with ETIMEDOUT. Allow 2 s per attempt.
setDefaultAutoSelectFamilyAttemptTimeout(2_000);

interface WorkerRpcRequest {
  id: string;
  method: string;
  args: any[];
}

const parentPort = (process as any).parentPort as
  | {
      on: (event: string, listener: (msg: { data: any }) => void) => void;
      postMessage: (msg: any) => void;
    }
  | undefined;

if (!parentPort) {
  console.error("agent-worker must be launched via Electron utilityProcess.fork()");
  process.exit(1);
}

const runtime = new AgentRuntime({
  mcpServerScriptPath: process.env.MCP_SERVER_SCRIPT_PATH || "",
  collectionsDbPath: process.env.COLLECTIONS_DB_PATH || "",
  appDbPath: process.env.APP_DB_PATH || "",
  apiKey: process.env.GEMINI_API_KEY || "",
  chatModel: process.env.BOOKMARK_AGENT_CHAT_MODEL || "gemini-3.1-flash-lite",
  mcpConfigPath: process.env.COLLECTIONS_MCP_CONFIG || undefined,
  runMcpAsElectronNode: true,
  onChatStream: (sessionId, event) => {
    parentPort.postMessage({ type: "event", channel: "chat:stream", payload: { sessionId, event } });
  },
  onSyncProgress: (ev) => {
    parentPort.postMessage({ type: "event", channel: "sync:progress", payload: ev });
  },
  onCollectionsChanged: (ev) => {
    parentPort.postMessage({ type: "event", channel: "collections:changed", payload: ev });
  },
});

const readyPromise = runtime
  .start()
  .then(() => {
    parentPort.postMessage({ type: "ready" });
  })
  .catch((err) => {
    parentPort.postMessage({ type: "fatal", error: err?.message || String(err) });
  });

parentPort.on("message", async ({ data }: { data: WorkerRpcRequest }) => {
  if (!data || !data.id || !data.method) return;
  try {
    await readyPromise;
    if (data.method === "shutdown") {
      await runtime.close();
      parentPort.postMessage({ type: "response", id: data.id, ok: true, data: { closed: true } });
      process.exit(0);
      return;
    }
    const fn = (runtime as any)[data.method];
    if (typeof fn !== "function") {
      throw new Error(`Unknown worker method: ${data.method}`);
    }
    const result = await fn.apply(runtime, data.args || []);
    parentPort.postMessage({ type: "response", id: data.id, ok: true, data: result });
  } catch (err: any) {
    parentPort.postMessage({
      type: "response",
      id: data.id,
      ok: false,
      error: err?.message || String(err),
    });
  }
});
