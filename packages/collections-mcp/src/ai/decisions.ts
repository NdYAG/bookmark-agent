import { DiskAiCache } from "./cache.js";
import { PriorityLevel, RateLimiterRegistry } from "./limiter.js";

/**
 * Isolated v1beta Decisions API (`gemini-decision-1`) client.
 * Verified schema from S3:
 * - `score` question -> `criteria: string[]` (0-indexed array of level descriptions)
 * - `choice` question -> `criteria: Record<string, string>` (option key -> description)
 * - `noul` question -> no `criteria`
 */
export type DecisionQuestion =
  | {
      type: "score";
      instructions: string;
      criteria: string[];
    }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: "noul";
      instructions: string;
    };

export interface DecisionScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}

export interface DecisionChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface DecisionNoulAnswer {
  type: "noul";
  noul: number;
  confidence: number;
}

export type DecisionAnswer =
  | DecisionScoreAnswer
  | DecisionChoiceAnswer
  | DecisionNoulAnswer;

export interface DecisionsResponse {
  answers: Record<string, DecisionAnswer>;
  usage?: {
    total_tokens: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
}

export class DecisionsClient {
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly limiter: RateLimiterRegistry;
  private readonly cache: DiskAiCache;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    apiKey: string | null;
    model?: string;
    limiter: RateLimiterRegistry;
    cache: DiskAiCache;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || "gemini-decision-1";
    this.limiter = opts.limiter;
    this.cache = opts.cache;
    this.fetchFn = opts.fetchFn || fetch;
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async create(params: {
    input: string;
    questions: Record<string, DecisionQuestion>;
    priority?: PriorityLevel;
    promptVersion?: string;
  }): Promise<DecisionsResponse> {
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY not configured for DecisionsClient");
    }

    const promptVersion = params.promptVersion || "decisions-v1";
    const payload = {
      model: this.model,
      input: params.input,
      questions: params.questions,
    };

    const { value } = await this.cache.getOrCompute<DecisionsResponse>(
      {
        model: this.model,
        promptVersion,
        input: payload,
      },
      async () => {
        const estTokens = Math.ceil(
          (params.input.length + JSON.stringify(params.questions).length) / 3,
        );
        const bucket = this.limiter.bucket(this.model);

        return bucket.schedule(
          async () => {
            const url = `https://generativelanguage.googleapis.com/v1beta/decisions?key=${this.apiKey}`;
            const res = await this.fetchFn(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            const data = (await res.json()) as any;
            if (!res.ok) {
              if (res.status === 429) {
                const isDaily = JSON.stringify(data).includes("PerDay");
                bucket.record429({ isDaily });
              }
              throw new Error(
                `Decisions API error (${res.status}): ${JSON.stringify(data?.error || data)}`,
              );
            }
            return data as DecisionsResponse;
          },
          {
            priority: params.priority ?? "interactive",
            requestCount: 1,
            estimatedTokens: estTokens,
          },
        );
      },
    );

    return value;
  }
}
