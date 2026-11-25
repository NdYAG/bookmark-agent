import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
}

export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

/**
 * Main-process-only secret store backed by Electron `safeStorage`.
 * Plaintext secrets NEVER cross IPC to the renderer process.
 */
export class AppSecretStore {
  private readonly filePath: string;
  private readonly safeStorage?: SafeStorageLike;

  constructor(dataDir: string, safeStorage?: SafeStorageLike) {
    this.filePath = join(dataDir, "secrets.enc.json");
    this.safeStorage = safeStorage;
  }

  setGeminiApiKey(rawKey: string): void {
    const trimmed = rawKey.trim();
    mkdirSync(dirname(this.filePath), { recursive: true });
    let existing: Record<string, { encrypted: boolean; value: string }> = {};
    if (existsSync(this.filePath)) {
      try {
        existing = JSON.parse(readFileSync(this.filePath, "utf8"));
      } catch {
        existing = {};
      }
    }

    if (!trimmed) {
      delete existing.geminiApiKey;
      writeFileSync(this.filePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
      return;
    }

    if (this.safeStorage?.isEncryptionAvailable()) {
      const buf = this.safeStorage.encryptString(trimmed);
      existing.geminiApiKey = {
        encrypted: true,
        value: buf.toString("base64"),
      };
    } else {
      // Fallback for non-Electron unit tests or environments without OS keyring
      existing.geminiApiKey = {
        encrypted: false,
        value: Buffer.from(trimmed, "utf8").toString("base64"),
      };
    }

    writeFileSync(this.filePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }

  resolveGeminiApiKey(): {
    key: string | null;
    source: "safeStorage" | "env" | "keychain" | "none";
  } {
    if (existsSync(this.filePath)) {
      try {
        const data = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<
          string,
          { encrypted: boolean; value: string }
        >;
        const entry = data.geminiApiKey;
        if (entry?.value) {
          const buf = Buffer.from(entry.value, "base64");
          const plain =
            entry.encrypted && this.safeStorage?.isEncryptionAvailable()
              ? this.safeStorage.decryptString(buf)
              : buf.toString("utf8");
          if (plain.trim()) {
            return { key: plain.trim(), source: "safeStorage" };
          }
        }
      } catch {
        // Fall through to env
      }
    }

    const envKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
    if (envKey) {
      return { key: envKey.replace(/^["']|["']$/g, ""), source: "env" };
    }

    return { key: null, source: "none" };
  }

  getSafeStatus(): {
    hasKey: boolean;
    source: "safeStorage" | "env" | "keychain" | "none";
    masked: string | null;
  } {
    const resolved = this.resolveGeminiApiKey();
    return {
      hasKey: Boolean(resolved.key),
      source: resolved.source,
      masked: maskApiKey(resolved.key),
    };
  }
}
