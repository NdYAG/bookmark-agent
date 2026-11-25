import { AuthManager, BrowserSession, IdentityConfig, NeedsLoginError } from "../auth/index.js";
import { CollectionsDB, UpsertItemInput } from "../db/index.js";

export interface RawSocialItem {
  id: string;
  url: string;
  [key: string]: unknown;
}

export interface HealthCheckConfig<T extends RawSocialItem = RawSocialItem> {
  minFieldsFilled: Record<string, { threshold: number; check: (item: T) => boolean }>;
  requireNonEmptyOnFirstSync?: boolean;
}

export interface HealthCheckReport {
  healthy: boolean;
  itemCount: number;
  rates: Record<string, number>;
  warnings: string[];
}

export interface PageState {
  url: string;
  vis: string;
  focus: boolean;
  tab: string | null;
}

export interface SocialSource<T extends RawSocialItem = RawSocialItem> {
  id: string;
  account: string;
  adapter: string;
  identity: IdentityConfig;
  listUrl: string;
  order: "newest-first" | "unordered";
  itemSelector: string;
  extract: string;
  detailExtract?: string;
  validatePage?: (state: PageState) => { ok: boolean; reason?: string };
  scroll: {
    scrollJs?: string;
    pauseMs: [number, number];
    maxIdleRounds: number;
  };
  health: HealthCheckConfig<T>;
  toUpsertInput: (item: T, index: number, baseTimeMs: number) => UpsertItemInput;
}

export interface SyncProgress {
  sourceId: string;
  round: number;
  fetched: number;
  maxItems: number;
  hitCursor: boolean;
}

export interface SyncResult {
  sourceId: string;
  fetchedCount: number;
  inserted: number;
  updated: number;
  tombstoned: number;
  hitCursor: boolean;
  previousCursor: string | null;
  newCursor: string | null;
  changedIds: string[];
  health: HealthCheckReport;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepRand = ([min, max]: [number, number]) =>
  sleep(min + Math.random() * Math.max(0, max - min));

/**
 * Evaluates field fill rates and bookmark markers against the source's health rules.
 */
export function checkSourceHealth<T extends RawSocialItem>(
  source: SocialSource<T>,
  items: T[],
  opts?: { hitCursor?: boolean },
): HealthCheckReport {
  const warnings: string[] = [];
  const rates: Record<string, number> = {};

  if (items.length === 0) {
    if (!opts?.hitCursor && source.health.requireNonEmptyOnFirstSync !== false) {
      warnings.push(
        `Source '${source.id}' extracted 0 items without hitting an incremental cursor (DOM structure or selector '${source.itemSelector}' may have changed).`,
      );
    }
    return {
      healthy: warnings.length === 0,
      itemCount: 0,
      rates,
      warnings,
    };
  }

  for (const [fieldName, rule] of Object.entries(source.health.minFieldsFilled)) {
    const filled = items.filter((it) => {
      try {
        return Boolean(rule.check(it));
      } catch {
        return false;
      }
    }).length;
    const rate = filled / items.length;
    rates[fieldName] = Number(rate.toFixed(4));
    if (rate < rule.threshold) {
      warnings.push(
        `Field '${fieldName}' fill rate ${(rate * 100).toFixed(1)}% is below threshold ${(rule.threshold * 100).toFixed(1)}% (${filled}/${items.length}).`,
      );
    }
  }

  return {
    healthy: warnings.length === 0,
    itemCount: items.length,
    rates,
    warnings,
  };
}

/**
 * Runs an incremental (or full) sync for a SocialSource:
 * - Serializes access per identity
 * - Checks login (throws NeedsLoginError with sourceId if expired/missing)
 * - Loops extract -> deduplicate -> stop on cursor -> scroll -> pause
 * - Runs health check before committing items (aborts if extract is broken!)
 * - Upserts items into CollectionsDB and updates `sources` cursor
 */
export async function syncSocialSource<T extends RawSocialItem>(opts: {
  source: SocialSource<T>;
  db: CollectionsDB;
  auth: AuthManager;
  maxItems?: number;
  ignoreCursor?: boolean;
  customSession?: BrowserSession;
  onProgress?: (p: SyncProgress) => void | Promise<void>;
  abortOnUnhealthy?: boolean;
}): Promise<SyncResult> {
  const {
    source,
    db,
    auth,
    maxItems = 200,
    ignoreCursor = false,
    customSession,
    onProgress,
    abortOnUnhealthy = true,
  } = opts;

  return auth.withIdentityLock(source.identity.id, async () => {
    const sourceRow = db.getSource(source.id);
    const previousCursor = ignoreCursor ? null : (sourceRow?.cursor ?? null);

    let session: BrowserSession;
    try {
      session =
        customSession ??
        (await auth.openSession(source.identity, `sync-${source.id}`, source.listUrl));
    } catch (err) {
      if (err instanceof NeedsLoginError) {
        db.upsertSource({
          id: source.id,
          adapter: source.adapter,
          account: source.account,
          identity: source.identity.id,
          cursor: sourceRow?.cursor ?? null,
          last_sync_at: new Date().toISOString(),
          last_status: "NEEDS_LOGIN",
        });
        throw new NeedsLoginError(err.identityId, err.message, source.id);
      }
      throw err;
    }

    const seen = new Set<string>();
    const collected: T[] = [];
    let idle = 0;
    let hitCursor = false;

    try {
      await session.waitSelector(source.itemSelector, 20000);

      for (
        let round = 1;
        collected.length < maxItems && idle < source.scroll.maxIdleRounds && !hitCursor;
        round++
      ) {
        if (source.validatePage) {
          const st = await session.evalJs<PageState>(
            '({ url: location.href, vis: document.visibilityState, focus: document.hasFocus(), tab: document.querySelector("[role=tab][aria-selected=true]")?.innerText?.trim() ?? null })',
          );
          const check = source.validatePage(st);
          if (!check.ok) {
            throw new Error(
              `Page validation failed on round ${round}: ${check.reason || st.url}`,
            );
          }
        }

        const batch = await session.evalJs<T[]>(source.extract);
        if (!Array.isArray(batch)) {
          throw new Error(`Extract script for '${source.id}' did not return an array`);
        }

        let freshCount = 0;
        for (const item of batch) {
          // Even if an item has no id (e.g. broken extractor), inspect it in health check
          const itemKey = item?.id ? String(item.id) : `__missing_id_${collected.length}_${freshCount}`;
          if (seen.has(itemKey)) continue;
          seen.add(itemKey);

          if (
            source.order === "newest-first" &&
            previousCursor &&
            item?.id &&
            String(item.id) === previousCursor
          ) {
            hitCursor = true;
            break;
          }

          collected.push(item);
          freshCount++;
          if (collected.length >= maxItems) break;
        }

        idle = freshCount > 0 ? 0 : idle + 1;

        if (onProgress) {
          await onProgress({
            sourceId: source.id,
            round,
            fetched: collected.length,
            maxItems,
            hitCursor,
          });
        }

        if (hitCursor || collected.length >= maxItems || idle >= source.scroll.maxIdleRounds) {
          break;
        }

        const scrollJs =
          source.scroll.scrollJs ||
          "window.scrollBy(0, Math.round(innerHeight * (0.6 + Math.random() * 0.3)))";
        await session.evalJs(scrollJs);
        await sleepRand(source.scroll.pauseMs);
      }
    } finally {
      await session.close().catch(() => {});
      if (!customSession && source.identity.mode === "external-chrome") {
        await auth.stopExternalChrome(source.identity.id).catch(() => {});
      }
    }

    const health = checkSourceHealth(source, collected, { hitCursor });
    if (!health.healthy && abortOnUnhealthy) {
      db.upsertSource({
        id: source.id,
        adapter: source.adapter,
        account: source.account,
        identity: source.identity.id,
        cursor: sourceRow?.cursor ?? null,
        last_sync_at: new Date().toISOString(),
        last_status: `UNHEALTHY: ${health.warnings.join("; ")}`,
      });
      const err = new Error(
        `HEALTH_CHECK_FAILED for '${source.id}': ${health.warnings.join(" | ")}`,
      );
      (err as any).code = "HEALTH_CHECK_FAILED";
      (err as any).health = health;
      throw err;
    }

    let inserted = 0;
    let updated = 0;
    let tombstoned = 0;
    const changedIds: string[] = [];
    const baseTimeMs = Date.now();

    const tx = db.db.transaction(() => {
      for (let i = 0; i < collected.length; i++) {
        const upsertInput = source.toUpsertInput(collected[i], i, baseTimeMs);
        const res = db.upsertItem(upsertInput);
        if (res.status === "inserted") {
          inserted++;
          changedIds.push(res.id);
        } else if (res.status === "updated") {
          updated++;
        } else if (res.status === "tombstoned") {
          tombstoned++;
        }
      }
    });
    tx();

    // Update incremental cursor to the newest item seen (index 0)
    const newCursor =
      collected.length > 0 && collected[0].id
        ? String(collected[0].id)
        : previousCursor;

    db.upsertSource({
      id: source.id,
      adapter: source.adapter,
      account: source.account,
      identity: source.identity.id,
      cursor: newCursor,
      last_sync_at: new Date().toISOString(),
      last_status: health.healthy ? "OK" : `WARN: ${health.warnings.join("; ")}`,
    });

    return {
      sourceId: source.id,
      fetchedCount: collected.length,
      inserted,
      updated,
      tombstoned,
      hitCursor,
      previousCursor,
      newCursor,
      changedIds,
      health,
    };
  });
}
