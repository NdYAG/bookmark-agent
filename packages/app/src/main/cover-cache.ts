import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

/**
 * Local cover image cache (`~/Library/Application Support/bookmark-agent/covers/`):
 * Downloads remote cover images once (with no-referrer to avoid CDN hotlink blocks)
 * and serves them from local disk thereafter.
 */
export class CoverCache {
  private readonly dir: string;
  private readonly fetchFn: typeof fetch;
  private readonly inflight = new Map<string, Promise<{ path: string; mime: string } | null>>();

  constructor(dir: string, fetchFn: typeof fetch = fetch) {
    this.dir = dir;
    this.fetchFn = fetchFn;
    mkdirSync(dir, { recursive: true });
  }

  private hashUrl(url: string): string {
    return createHash("sha256").update(url).digest("hex").slice(0, 32);
  }

  findCached(remoteUrl: string): { path: string; mime: string } | null {
    const key = this.hashUrl(remoteUrl);
    for (const [ext, mime] of Object.entries(EXT_TO_MIME)) {
      const p = join(this.dir, `${key}.${ext}`);
      if (existsSync(p)) {
        return { path: p, mime };
      }
    }
    return null;
  }

  async ensureCached(remoteUrl: string): Promise<{ path: string; mime: string } | null> {
    if (!/^https?:\/\//i.test(remoteUrl)) return null;
    const hit = this.findCached(remoteUrl);
    if (hit) return hit;

    const existingPromise = this.inflight.get(remoteUrl);
    if (existingPromise) return existingPromise;

    const job = (async () => {
      try {
        const res = await this.fetchFn(remoteUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          },
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;

        const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const ext = MIME_TO_EXT[contentType] || "jpg";
        const mime = EXT_TO_MIME[ext] || "image/jpeg";
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return null;

        const outPath = join(this.dir, `${this.hashUrl(remoteUrl)}.${ext}`);
        writeFileSync(outPath, buf);
        return { path: outPath, mime };
      } catch {
        return null;
      } finally {
        this.inflight.delete(remoteUrl);
      }
    })();

    this.inflight.set(remoteUrl, job);
    return job;
  }

  async readCachedDataUrl(remoteUrl: string): Promise<string | null> {
    const entry = await this.ensureCached(remoteUrl);
    if (!entry) return null;
    const bytes = readFileSync(entry.path);
    return `data:${entry.mime};base64,${bytes.toString("base64")}`;
  }
}
