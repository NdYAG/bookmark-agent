import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type LoginMode = "external-chrome" | "automated-handoff";

export type LoginStatus = "VALID" | "EXPIRED" | "MISSING" | "ERROR";

export interface IdentityConfig {
  id: string;
  mode: LoginMode;
  checkUrl: string;
  loginUrl?: string;
  checkText?: string;
  checkFn?: string;
  checkUrlGlob?: string;
  doneFn?: string;
  cdpPort?: number;
  notes?: string;
}

export interface BrowserSession {
  readonly sessionName: string;
  readonly identityId: string;
  readonly mode: LoginMode;
  evalJs<T = unknown>(js: string): Promise<T>;
  waitSelector(selector: string, timeoutMs?: number): Promise<void>;
  getUrl(): Promise<string>;
  close(): Promise<void>;
}

const KEYCHAIN_SERVICE =
  process.env.BROWSER_LOGIN_KEYCHAIN_SERVICE || "browser-login-state-key";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ensures AGENT_BROWSER_ENCRYPTION_KEY is set via env or macOS Keychain (never logged).
 */
export function ensureEncryptionKey(): string {
  if (process.env.AGENT_BROWSER_ENCRYPTION_KEY) {
    return process.env.AGENT_BROWSER_ENCRYPTION_KEY;
  }
  if (process.platform === "darwin") {
    try {
      const existing = execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (existing) {
        process.env.AGENT_BROWSER_ENCRYPTION_KEY = existing;
        return existing;
      }
    } catch {
      // Generate and store a new 32-byte hex key in Keychain
      const generated = randomBytes(32).toString("hex");
      try {
        execFileSync(
          "security",
          [
            "add-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            process.env.USER || "default",
            "-w",
            generated,
          ],
          { stdio: "ignore" },
        );
      } catch {
        // Ignore keychain write errors in non-interactive environments
      }
      process.env.AGENT_BROWSER_ENCRYPTION_KEY = generated;
      return generated;
    }
  }
  const fallback = randomBytes(32).toString("hex");
  process.env.AGENT_BROWSER_ENCRYPTION_KEY = fallback;
  return fallback;
}

/**
 * TypeScript port of ab-login + chrome-profile.sh (`external-chrome` & `automated-handoff`).
 * Strictly adheres to browser-login rules:
 * - Never reads or logs cookies, storage, network headers, or state files.
 * - Serializes sessions per identity so concurrent tasks don't collide.
 */
export class AuthManager {
  private readonly abBin: string;
  private readonly configPath: string;
  private readonly profileRoot: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly forgottenIdentities = new Set<string>();

  constructor(opts?: { abBin?: string; configPath?: string; profileRoot?: string }) {
    this.abBin = opts?.abBin || process.env.AGENT_BROWSER_BIN || "agent-browser";
    this.configPath =
      opts?.configPath ||
      process.env.BROWSER_LOGIN_CONFIG ||
      join(homedir(), ".config/browser-login/identities.json");
    this.profileRoot =
      opts?.profileRoot ||
      process.env.CHROME_PROFILE_ROOT ||
      join(homedir(), ".config/browser-login/profiles");
  }

  /**
   * Serializes execution per identity to prevent concurrent session collisions.
   */
  async withIdentityLock<T>(identityId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(identityId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(identityId, next);
    return next;
  }

  loadIdentitiesFile(): Record<string, Partial<IdentityConfig>> {
    if (!existsSync(this.configPath)) return {};
    try {
      return JSON.parse(readFileSync(this.configPath, "utf8"));
    } catch {
      return {};
    }
  }

  saveIdentityConfig(identity: IdentityConfig): void {
    const all = this.loadIdentitiesFile();
    all[identity.id] = {
      mode: identity.mode,
      checkUrl: identity.checkUrl,
      loginUrl: identity.loginUrl,
      checkText: identity.checkText,
      checkFn: identity.checkFn,
      checkUrlGlob: identity.checkUrlGlob,
      doneFn: identity.doneFn,
      cdpPort: identity.cdpPort,
      notes: identity.notes,
    };
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(all, null, 2));
  }

  private checkFlags(identity: IdentityConfig): string[] {
    const flags: string[] = [];
    if (identity.checkText) flags.push("--restore-check-text", identity.checkText);
    if (identity.checkFn) flags.push("--restore-check-fn", identity.checkFn);
    if (identity.checkUrlGlob) flags.push("--restore-check-url", identity.checkUrlGlob);
    if (flags.length === 0) {
      throw new Error(
        `Identity '${identity.id}' requires at least one of checkText, checkFn, or checkUrlGlob`,
      );
    }
    return flags;
  }

  private profileDir(identityId: string): string {
    return join(this.profileRoot, identityId);
  }

  private async isCdpPortUp(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private isExternalChromeRunning(identityId: string): boolean {
    const dir = this.profileDir(identityId);
    try {
      execFileSync("pgrep", ["-f", `--user-data-dir=${dir}( |$)`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  async startExternalChromeForScraping(identity: IdentityConfig): Promise<number> {
    const port = identity.cdpPort || Number(process.env.CHROME_DEBUG_PORT || 9333);
    if (await this.isCdpPortUp(port)) {
      return port;
    }
    const dir = this.profileDir(identity.id);
    if (this.isExternalChromeRunning(identity.id)) {
      await this.stopExternalChrome(identity.id);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const chromeApp = process.env.CHROME_APP || "Google Chrome";
    await run("open", [
      "-n",
      "-a",
      chromeApp,
      "--args",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "about:blank",
    ]);

    for (let i = 0; i < 40; i++) {
      if (await this.isCdpPortUp(port)) return port;
      await sleep(500);
    }
    throw new Error(`Chrome debug port ${port} did not come up for identity '${identity.id}'`);
  }

  async stopExternalChrome(identityId: string): Promise<void> {
    const dir = this.profileDir(identityId);
    if (!this.isExternalChromeRunning(identityId)) return;
    try {
      execFileSync("pkill", ["-TERM", "-f", `--user-data-dir=${dir}( |$)`], { stdio: "ignore" });
    } catch {
      // Ignore pkill non-zero exit
    }
    for (let i = 0; i < 20; i++) {
      if (!this.isExternalChromeRunning(identityId)) return;
      await sleep(300);
    }
  }

  /**
   * Checks whether the identity is currently logged in:
   * - Returns "VALID", "EXPIRED", or "MISSING"
   */
  async check(identity: IdentityConfig): Promise<{
    identityId: string;
    mode: LoginMode;
    status: LoginStatus;
    detail?: string;
  }> {
    if (this.forgottenIdentities.has(identity.id)) {
      return {
        identityId: identity.id,
        mode: identity.mode,
        status: "MISSING",
        detail: "Identity state was forgotten; run handoff to log in again.",
      };
    }

    if (identity.mode === "external-chrome") {
      const dir = this.profileDir(identity.id);
      if (!existsSync(dir)) {
        return {
          identityId: identity.id,
          mode: identity.mode,
          status: "MISSING",
          detail: `Chrome profile directory not initialized yet: ${dir}`,
        };
      }
      // If CDP port is currently open, probe the checkUrl in a temporary tab; otherwise check profile presence
      const port = identity.cdpPort || Number(process.env.CHROME_DEBUG_PORT || 9333);
      if (await this.isCdpPortUp(port)) {
        try {
          const session = await this.openCdpSession(identity, `check-${identity.id}`, identity.checkUrl, port);
          const url = await session.getUrl();
          await session.close();
          if (/\/i\/flow\/login|\/i\/jf\/onboarding|\/login/.test(url)) {
            return { identityId: identity.id, mode: identity.mode, status: "EXPIRED", detail: `Redirected to ${url}` };
          }
          return { identityId: identity.id, mode: identity.mode, status: "VALID" };
        } catch (e: any) {
          return { identityId: identity.id, mode: identity.mode, status: "EXPIRED", detail: e?.message };
        }
      }
      // Profile exists on disk
      return {
        identityId: identity.id,
        mode: identity.mode,
        status: "VALID",
        detail: "Dedicated Chrome profile exists on disk",
      };
    }

    // automated-handoff mode (ab-login restore state probe)
    ensureEncryptionKey();
    const sessionName = `probe-${identity.id}`;
    const flags = this.checkFlags(identity);
    try {
      const { stdout } = await run(
        this.abBin,
        [
          "--session",
          sessionName,
          "--json",
          "--restore",
          identity.id,
          "--restore-save",
          "never",
          ...flags,
          "open",
          identity.checkUrl,
        ],
        { env: process.env, maxBuffer: 16 << 20 },
      ).catch((e) => ({ stdout: e.stdout || "" }));

      await run(this.abBin, ["--session", sessionName, "close"], { env: process.env }).catch(
        () => {},
      );

      let restoreStatus = "error";
      try {
        const parsed = JSON.parse(stdout);
        restoreStatus = parsed?.data?.lifecycle?.restoreStatus || "error";
      } catch {
        restoreStatus = "error";
      }

      if (restoreStatus === "loaded") {
        return { identityId: identity.id, mode: identity.mode, status: "VALID" };
      }
      if (restoreStatus === "loaded_but_invalid") {
        return { identityId: identity.id, mode: identity.mode, status: "EXPIRED" };
      }
      if (restoreStatus === "missing") {
        return { identityId: identity.id, mode: identity.mode, status: "MISSING" };
      }
      return { identityId: identity.id, mode: identity.mode, status: "ERROR", detail: restoreStatus };
    } catch (e: any) {
      return { identityId: identity.id, mode: identity.mode, status: "ERROR", detail: e?.message };
    }
  }

  /**
   * Handoff login to human:
   * - For `external-chrome` (X): opens normal Google Chrome with dedicated profile (no debug port, no automation flags).
   * - For `automated-handoff`: opens headed agent-browser window with `--restore-save always` and waits for `doneFn`.
   */
  async handoff(
    identity: IdentityConfig,
    opts?: { timeoutSec?: number },
  ): Promise<{
    identityId: string;
    mode: LoginMode;
    status: "VALID" | "PENDING_USER_ACTION" | "TIMEOUT" | "EXPIRED";
    instructions: string;
  }> {
    this.forgottenIdentities.delete(identity.id);
    const loginUrl = identity.loginUrl || identity.checkUrl;

    if (identity.mode === "external-chrome") {
      await this.stopExternalChrome(identity.id);
      const dir = this.profileDir(identity.id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const chromeApp = process.env.CHROME_APP || "Google Chrome";
      await run("open", [
        "-n",
        "-a",
        chromeApp,
        "--args",
        `--user-data-dir=${dir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        loginUrl,
      ]);

      return {
        identityId: identity.id,
        mode: identity.mode,
        status: "PENDING_USER_ACTION",
        instructions:
          `已打开专用 Chrome 窗口（profile: '${identity.id}'，无调试端口、无自动化特征）。\n` +
          `1. 请在该窗口手动完成登录（含 2FA / 验证码）。\n` +
          `2. 登录完成后按 Cmd+Q 退出该专用 Chrome 窗口（将登录状态落盘），然后重新调用 app_sync。`,
      };
    }

    // automated-handoff mode
    ensureEncryptionKey();
    const timeoutSec = opts?.timeoutSec ?? 600;
    const sessionName = `login-${identity.id}`;
    const doneFn =
      identity.doneFn ||
      (() => {
        const l = new URL(loginUrl);
        const c = new URL(identity.checkUrl);
        return `location.origin===${JSON.stringify(c.origin)} && !location.pathname.startsWith(${JSON.stringify(l.pathname)})`;
      })();

    await run(this.abBin, ["--session", sessionName, "close"], { env: process.env }).catch(() => {});
    await run(
      this.abBin,
      [
        "--session",
        sessionName,
        "--headed",
        "--restore",
        identity.id,
        "--restore-save",
        "always",
        "open",
        loginUrl,
      ],
      { env: process.env },
    );

    try {
      await run(
        this.abBin,
        ["--session", sessionName, "wait", "--fn", doneFn, "--timeout", String(timeoutSec * 1000)],
        { env: process.env },
      );
    } catch {
      await run(this.abBin, ["--session", sessionName, "close"], { env: process.env }).catch(
        () => {},
      );
      return {
        identityId: identity.id,
        mode: identity.mode,
        status: "TIMEOUT",
        instructions: `Wait for login timed out after ${timeoutSec}s`,
      };
    }

    await sleep(2000);
    await run(this.abBin, ["--session", sessionName, "close"], { env: process.env }).catch(() => {});
    const checkRes = await this.check(identity);
    return {
      identityId: identity.id,
      mode: identity.mode,
      status: checkRes.status === "VALID" ? "VALID" : "EXPIRED",
      instructions: checkRes.status === "VALID" ? "Login succeeded and saved." : "Login still invalid after handoff.",
    };
  }

  /**
   * Forgets saved login state so next sync triggers `NEEDS_LOGIN`.
   */
  async forget(
    identity: IdentityConfig,
    opts?: { deleteProfileDir?: boolean },
  ): Promise<{ identityId: string; status: "FORGOTTEN" }> {
    this.forgottenIdentities.add(identity.id);
    if (identity.mode === "external-chrome") {
      await this.stopExternalChrome(identity.id);
      if (opts?.deleteProfileDir) {
        rmSync(this.profileDir(identity.id), { recursive: true, force: true });
      }
    } else {
      ensureEncryptionKey();
      await run(this.abBin, ["state", "clear", identity.id], { env: process.env }).catch(() => {});
    }
    return { identityId: identity.id, status: "FORGOTTEN" };
  }

  /**
   * Clear soft-forget mark (e.g. after user completes external-chrome login handoff).
   */
  markLoginCompleted(identityId: string): void {
    this.forgottenIdentities.delete(identityId);
  }

  /**
   * Opens a never-save working browser session for scraping/detail extraction.
   * Throws structured `NeedsLoginError` if the identity is not logged in.
   */
  async openSession(
    identity: IdentityConfig,
    sessionName: string,
    targetUrl?: string,
  ): Promise<BrowserSession> {
    if (this.forgottenIdentities.has(identity.id)) {
      throw new NeedsLoginError(identity.id, "Identity was forgotten; login handoff required.");
    }

    const url = targetUrl || identity.checkUrl;

    if (identity.mode === "external-chrome") {
      const dir = this.profileDir(identity.id);
      if (!existsSync(dir)) {
        throw new NeedsLoginError(
          identity.id,
          `Dedicated Chrome profile not found at ${dir}. Run app_login_handoff first.`,
        );
      }
      const port = await this.startExternalChromeForScraping(identity);
      const session = await this.openCdpSession(identity, sessionName, url, port);
      const landedUrl = await session.getUrl();
      if (/\/i\/flow\/login|\/i\/jf\/onboarding|\/login/.test(landedUrl)) {
        await session.close();
        await this.stopExternalChrome(identity.id);
        throw new NeedsLoginError(identity.id, `Landed on login page (${landedUrl})`);
      }
      return session;
    }

    // automated-handoff never-save session
    ensureEncryptionKey();
    const flags = this.checkFlags(identity);
    const { stdout } = await run(
      this.abBin,
      [
        "--session",
        sessionName,
        "--json",
        "--restore",
        identity.id,
        "--restore-save",
        "never",
        ...flags,
        "open",
        url,
      ],
      { env: process.env, maxBuffer: 16 << 20 },
    ).catch((e) => ({ stdout: e.stdout || "" }));

    let restoreStatus = "error";
    try {
      restoreStatus = JSON.parse(stdout)?.data?.lifecycle?.restoreStatus || "error";
    } catch {
      restoreStatus = "error";
    }

    if (restoreStatus !== "loaded") {
      await run(this.abBin, ["--session", sessionName, "close"], { env: process.env }).catch(
        () => {},
      );
      throw new NeedsLoginError(identity.id, `Restore status: ${restoreStatus}`);
    }

    return this.createAbSessionWrapper(identity, sessionName, []);
  }

  private async openCdpSession(
    identity: IdentityConfig,
    sessionName: string,
    url: string,
    port: number,
  ): Promise<BrowserSession> {
    const baseArgs = ["--session", sessionName, "--cdp", String(port), "--pin-tab"];
    const ab = async (...args: string[]) =>
      (await run(this.abBin, [...baseArgs, ...args], { env: process.env, maxBuffer: 64 << 20 }))
        .stdout;

    // `tab new <url>` avoids `tab_gone` when Chrome was restarted
    await ab("tab", "new", url);
    await ab("wait", "--load", "domcontentloaded").catch(() => {});
    await sleep(2500);

    return this.createAbSessionWrapper(identity, sessionName, ["--cdp", String(port), "--pin-tab"]);
  }

  private createAbSessionWrapper(
    identity: IdentityConfig,
    sessionName: string,
    extraBaseArgs: string[],
  ): BrowserSession {
    const baseArgs = ["--session", sessionName, ...extraBaseArgs];

    return {
      sessionName,
      identityId: identity.id,
      mode: identity.mode,
      evalJs: async <T = unknown>(js: string): Promise<T> => {
        const child = execFile(
          this.abBin,
          [...baseArgs, "--json", "eval", "--stdin"],
          { env: process.env, maxBuffer: 64 << 20 },
        );
        child.stdin?.end(js);
        const stdout = await new Promise<string>((res, rej) => {
          let buf = "";
          child.stdout?.on("data", (d) => (buf += d));
          child.on("error", rej);
          child.on("close", () => res(buf));
        });
        const parsed = JSON.parse(stdout);
        if (!parsed.success) {
          throw new Error(parsed.error || "agent-browser eval failed");
        }
        return parsed.data.result as T;
      },
      waitSelector: async (selector: string, timeoutMs = 20000): Promise<void> => {
        await run(
          this.abBin,
          [...baseArgs, "wait", selector, "--timeout", String(timeoutMs)],
          { env: process.env },
        );
      },
      getUrl: async (): Promise<string> => {
        const { stdout } = await run(this.abBin, [...baseArgs, "get", "url"], {
          env: process.env,
        });
        return stdout.trim();
      },
      close: async (): Promise<void> => {
        await run(this.abBin, [...baseArgs, "close"], { env: process.env }).catch(() => {});
      },
    };
  }
}

export class NeedsLoginError extends Error {
  readonly code = "NEEDS_LOGIN";
  readonly identityId: string;
  readonly sourceId?: string;

  constructor(identityId: string, message?: string, sourceId?: string) {
    super(message || `NEEDS_LOGIN for identity '${identityId}'`);
    this.name = "NeedsLoginError";
    this.identityId = identityId;
    this.sourceId = sourceId;
  }
}
