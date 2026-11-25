export type PriorityLevel = "interactive" | "incremental" | "background";

const PRIORITY_ORDER: Record<PriorityLevel, number> = {
  interactive: 0, // User search query embed, right-click related rerank
  incremental: 1, // Live incremental sync enrich/embed
  background: 2,  // Full initial import / batch re-index
};

export interface BucketConfig {
  rpm: number;
  tpm: number;
  rpd: number;
}

export class QuotaExhaustedError extends Error {
  readonly code = "DAILY_QUOTA_EXHAUSTED";
  readonly model: string;
  readonly resetAt: string;

  constructor(model: string, resetAt: string, message?: string) {
    super(
      message ||
        `Daily quota (RPD) exhausted for model '${model}'. Paused until Pacific midnight (${resetAt}).`,
    );
    this.name = "QuotaExhaustedError";
    this.model = model;
    this.resetAt = resetAt;
  }
}

interface QueuedTask<T> {
  priority: PriorityLevel;
  requestCount: number;
  estimatedTokens: number;
  fn: () => Promise<T>;
  resolve: (val: T) => void;
  reject: (err: unknown) => void;
}

/**
 * Computes the next Pacific Time (America/Los_Angeles) midnight as ISO-8601 string.
 */
export function nextPacificMidnightIso(now = new Date()): string {
  // PST/PDT is UTC-8 or UTC-7; approximate next midnight PT conservatively at 08:00 UTC next day
  const d = new Date(now);
  d.setUTCHours(8, 0, 0, 0);
  if (d.getTime() <= now.getTime()) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString();
}

/**
 * Per-model token bucket rate limiter with:
 * - RPM, TPM, and RPD tracking
 * - Priority queue (interactive > incremental > background)
 * - Adaptive 429 backoff (reads Retry-After / RetryInfo and scales down effective RPM)
 * - Daily quota pause & resume state
 */
export class ModelBucket {
  readonly model: string;
  private config: BucketConfig;
  private effectiveRpm: number;

  private windowStartMs = Date.now();
  private usedRpm = 0;
  private usedTpm = 0;

  private dayResetIso = nextPacificMidnightIso();
  private usedRpd = 0;
  private dailyExhausted = false;
  private backoffUntilMs = 0;

  private queue: Array<QueuedTask<any>> = [];
  private processing = false;

  // Observability counters
  totalRequests = 0;
  totalTokens = 0;
  total429s = 0;

  constructor(model: string, config: BucketConfig) {
    this.model = model;
    this.config = { ...config };
    this.effectiveRpm = config.rpm;
  }

  getStats() {
    this.refreshWindows();
    return {
      model: this.model,
      config: this.config,
      effectiveRpm: this.effectiveRpm,
      usedRpm: this.usedRpm,
      usedTpm: this.usedTpm,
      usedRpd: this.usedRpd,
      dailyExhausted: this.dailyExhausted,
      dayResetIso: this.dayResetIso,
      queueLength: this.queue.length,
      totalRequests: this.totalRequests,
      totalTokens: this.totalTokens,
      total429s: this.total429s,
    };
  }

  /**
   * Manually reset daily quota (or simulate Pacific midnight reset in tests).
   */
  resetDailyQuota(): void {
    this.usedRpd = 0;
    this.dailyExhausted = false;
    this.dayResetIso = nextPacificMidnightIso();
  }

  private refreshWindows(nowMs = Date.now()): void {
    if (nowMs - this.windowStartMs >= 60_000) {
      this.windowStartMs = nowMs;
      this.usedRpm = 0;
      this.usedTpm = 0;
    }
    if (nowMs >= Date.parse(this.dayResetIso)) {
      this.resetDailyQuota();
    }
  }

  /**
   * Notifies the bucket of an HTTP 429 response so it can adaptively slow down and back off.
   */
  record429(opts?: { retryAfterMs?: number; isDaily?: boolean }): void {
    this.total429s++;
    if (opts?.isDaily) {
      this.dailyExhausted = true;
      return;
    }
    const waitMs = opts?.retryAfterMs ?? 15_000;
    this.backoffUntilMs = Math.max(this.backoffUntilMs, Date.now() + waitMs);
    // Adaptively scale down effective RPM by 20% (down to a floor of 1)
    this.effectiveRpm = Math.max(1, Math.floor(this.effectiveRpm * 0.8));
  }

  schedule<T>(
    fn: () => Promise<T>,
    opts?: {
      priority?: PriorityLevel;
      requestCount?: number; // Note: batchEmbedContents with N items passes requestCount = N
      estimatedTokens?: number;
    },
  ): Promise<T> {
    const priority = opts?.priority ?? "background";
    const requestCount = Math.max(1, opts?.requestCount ?? 1);
    const estimatedTokens = Math.max(1, opts?.estimatedTokens ?? 200);

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        requestCount,
        estimatedTokens,
        fn,
        resolve,
        reject,
      });
      // Keep sorted by priority (interactive first)
      this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const now = Date.now();
        this.refreshWindows(now);

        if (this.backoffUntilMs > now) {
          await new Promise((r) => setTimeout(r, this.backoffUntilMs - now));
          continue;
        }

        const task = this.queue[0];

        if (this.dailyExhausted || this.usedRpd + task.requestCount > this.config.rpd) {
          this.dailyExhausted = true;
          this.queue.shift();
          task.reject(new QuotaExhaustedError(this.model, this.dayResetIso));
          continue;
        }

        // Check minute window capacity
        const rpmCap = Math.max(1, this.effectiveRpm);
        const canFitRpm =
          this.usedRpm === 0 || this.usedRpm + task.requestCount <= rpmCap;
        const canFitTpm =
          this.usedTpm === 0 || this.usedTpm + task.estimatedTokens <= this.config.tpm;

        if (!canFitRpm || !canFitTpm) {
          const waitMs = Math.max(50, 60_000 - (now - this.windowStartMs));
          await new Promise((r) => setTimeout(r, Math.min(waitMs, 2000)));
          continue;
        }

        // Consume tokens and execute
        this.queue.shift();
        this.usedRpm += task.requestCount;
        this.usedTpm += task.estimatedTokens;
        this.usedRpd += task.requestCount;
        this.totalRequests += task.requestCount;
        this.totalTokens += task.estimatedTokens;

        try {
          const res = await task.fn();
          task.resolve(res);
        } catch (err) {
          task.reject(err);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

export class RateLimiterRegistry {
  private readonly buckets = new Map<string, ModelBucket>();
  private readonly defaults: Record<string, BucketConfig>;

  constructor(presets: Record<string, BucketConfig>) {
    this.defaults = presets;
    for (const [model, cfg] of Object.entries(presets)) {
      this.buckets.set(model, new ModelBucket(model, cfg));
    }
  }

  bucket(model: string): ModelBucket {
    let b = this.buckets.get(model);
    if (!b) {
      const cfg = this.defaults[model] ?? { rpm: 15, tpm: 50_000, rpd: 500 };
      b = new ModelBucket(model, cfg);
      this.buckets.set(model, b);
    }
    return b;
  }

  getAllStats() {
    return Object.fromEntries(
      [...this.buckets.entries()].map(([k, b]) => [k, b.getStats()]),
    );
  }
}
