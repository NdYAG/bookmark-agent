import { execFileSync } from "node:child_process";
import type { EnvCheckResult } from "../shared/types.js";

const MIN_AGENT_BROWSER_VERSION = "0.41.0";

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function checkAgentBrowserEnv(execFn: typeof execFileSync = execFileSync): EnvCheckResult {
  const installCommand = "npm install -g agent-browser@latest";
  try {
    const binPath = execFn("which", ["agent-browser"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();

    const versionRaw = execFn(binPath || "agent-browser", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();

    const match = /(\d+\.\d+\.\d+)/.exec(versionRaw);
    const version = match?.[1] || null;
    const ok = Boolean(version && compareSemver(version, MIN_AGENT_BROWSER_VERSION) >= 0);

    return {
      ok,
      installed: true,
      version,
      minVersion: MIN_AGENT_BROWSER_VERSION,
      path: binPath || null,
      message: ok
        ? `已检测到 agent-browser ${version}（满足 >= ${MIN_AGENT_BROWSER_VERSION}）`
        : `检测到 agent-browser ${version || versionRaw}，低于最低要求 ${MIN_AGENT_BROWSER_VERSION}，请升级。`,
      installCommand,
    };
  } catch {
    return {
      ok: false,
      installed: false,
      version: null,
      minVersion: MIN_AGENT_BROWSER_VERSION,
      path: null,
      message: `未检测到 agent-browser（同步 X / 小红书需要 >= ${MIN_AGENT_BROWSER_VERSION}）。`,
      installCommand,
    };
  }
}
