import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheKeyInput {
  model: string;
  promptVersion: string;
  input: unknown;
}

/**
 * Deterministic disk cache for all AI calls:
 * key = sha1(model + "\0" + promptVersion + "\0" + canonicalJson(input))
 */
export class DiskAiCache {
  readonly cacheDir: string;
  readonly enabled: boolean;
  hits = 0;
  misses = 0;

  constructor(opts: { dir: string; enabled?: boolean }) {
    this.cacheDir = opts.dir;
    this.enabled = opts.enabled !== false;
    if (this.enabled) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  static computeHash(params: CacheKeyInput): string {
    const payload =
      typeof params.input === "string"
        ? params.input
        : JSON.stringify(params.input);
    return createHash("sha1")
      .update(`${params.model}\0${params.promptVersion}\0${payload}`)
      .digest("hex");
  }

  private filePathFor(hash: string): string {
    const prefix = hash.slice(0, 2);
    const subDir = join(this.cacheDir, prefix);
    if (!existsSync(subDir)) {
      mkdirSync(subDir, { recursive: true });
    }
    return join(subDir, `${hash}.json`);
  }

  get<T>(params: CacheKeyInput): T | null {
    if (!this.enabled) return null;
    const hash = DiskAiCache.computeHash(params);
    const file = this.filePathFor(hash);
    if (!existsSync(file)) {
      this.misses++;
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { value: T };
      this.hits++;
      return parsed.value;
    } catch {
      this.misses++;
      return null;
    }
  }

  set<T>(params: CacheKeyInput, value: T): string {
    const hash = DiskAiCache.computeHash(params);
    if (!this.enabled) return hash;
    const file = this.filePathFor(hash);
    writeFileSync(
      file,
      JSON.stringify({
        hash,
        model: params.model,
        promptVersion: params.promptVersion,
        createdAt: new Date().toISOString(),
        value,
      }),
    );
    return hash;
  }

  async getOrCompute<T>(
    params: CacheKeyInput,
    computeFn: () => Promise<T>,
  ): Promise<{ value: T; cached: boolean; hash: string }> {
    const hash = DiskAiCache.computeHash(params);
    const existing = this.get<T>(params);
    if (existing !== null) {
      return { value: existing, cached: true, hash };
    }
    const value = await computeFn();
    this.set(params, value);
    return { value, cached: false, hash };
  }
}
