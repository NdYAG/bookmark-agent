import type { A2uiSurfaceSpec, ExpandedBookmarkItem } from "@bookmark-agent/catalog";
import type {
  AgentMessage,
  BookmarkAgentStreamEvent as AgentStreamEvent,
  SessionRecord,
} from "@bookmark-agent/agent-core";

export type ModelTier = "free" | "paid";

export interface AppSettings {
  chatProvider: "gemini";
  chatModel: string;
  tier: ModelTier;
  allowCloudForContent: boolean;
  onboardingCompleted: boolean;
  developerView: boolean;
  collectionsDbPath?: string;
}

export interface SafeSettingsPayload {
  settings: AppSettings;
  apiKeyStatus: {
    hasKey: boolean;
    source: "safeStorage" | "env" | "keychain" | "none";
    masked: string | null;
  };
}

export interface EnvCheckResult {
  ok: boolean;
  installed: boolean;
  version: string | null;
  minVersion: string;
  path: string | null;
  message: string;
  installCommand: string;
}

export interface ItemListParams {
  page?: number;
  pageSize?: number;
  source?: string;
  category?: string;
  author?: string;
  mediaType?: string;
  query?: string;
  sort?: "first_seen_desc" | "first_seen_asc" | "publish_desc" | "publish_asc";
}

export interface GridBookmarkItem {
  id: string;
  source: string;
  source_item_id: string;
  url: string;
  title: string | null;
  excerpt: string | null;
  note: string | null;
  author: string | null;
  cover_url: string | null;
  media_type: string | null;
  publish_date: string | null;
  first_seen_at: string;
  category: string | null;
}

export interface ItemListResponse {
  items: GridBookmarkItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CategoryInfo {
  id: string;
  name: string;
  description: string;
  examples: string[];
  sort: number;
  name_source?: "topics" | "llm" | "user";
}

export interface SourceInfo {
  id: string;
  adapter: string;
  account: string | null;
  identity: string | null;
  cursor: string | null;
  last_sync_at: string | null;
  last_status: string | null;
}

export interface MetaResponse {
  stats: {
    total_active_items: number;
    total_deleted_tombstones: number;
    total_embeddings: number;
    by_source: Array<{ source: string; count: number }>;
    by_media_type: Array<{ media_type: string; count: number }>;
    by_category: Array<{ category: string; count: number }>;
    top_authors: Array<{ author: string; count: number }>;
  };
  categories: CategoryInfo[];
  categoryCounts: Array<{ category: string; count: number }>;
  sources: SourceInfo[];
}

export interface RelatedCandidateItem {
  id: string;
  source: string;
  title: string | null;
  author: string | null;
  excerpt: string;
  url: string;
  cover_url: string | null;
  media_type: string | null;
  category: string | null;
  score: number;
  cos: number;
  decisionScore?: number;
  signals: string[];
  item?: ExpandedBookmarkItem;
}

export interface RelatedResponse {
  targetId: string;
  target: GridBookmarkItem | null;
  mode: string;
  elapsedMs: number;
  related: RelatedCandidateItem[];
  dismissedIds: string[];
}

export interface PendingCategoryItem {
  id: string;
  title: string | null;
  author: string | null;
  excerpt: string;
  suggestedCategoryId: string;
  score: number;
  source: string;
}

export interface SearchMessageHit {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  role: string;
  text: string;
  createdAt: string;
}

export interface SyncProgressEvent {
  sourceId: string;
  progress: number;
  total: number;
  message: string;
  status: "running" | "done" | "error" | "needs_login";
}

export interface CollectionsChangedEvent {
  sourceId?: string;
  ids: string[];
  inserted?: number;
}

export interface ChatStreamPayload {
  sessionId: string;
  event: AgentStreamEvent;
}

export interface SendMessageRequest {
  sessionId: string;
  text?: string;
  attachedItems?: Array<{
    id: string;
    title?: string | null;
    author?: string | null;
    excerpt?: string | null;
    url?: string;
  }>;
  allowWrites?: boolean;
}

export interface BookmarkApi {
  items: {
    list: (params: ItemListParams) => Promise<ItemListResponse>;
    update: (
      id: string,
      patch: { title?: string; excerpt?: string; note?: string; category?: string },
    ) => Promise<{ ok: boolean; item?: any; error?: string }>;
    remove: (id: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
    related: (id: string, k?: number, mode?: string) => Promise<RelatedResponse>;
    dismissRelated: (targetId: string, candidateId: string) => Promise<{ ok: boolean }>;
    resolveCover: (remoteUrl: string) => Promise<string | null>;
  };
  meta: {
    get: () => Promise<MetaResponse>;
    proposeTaxonomy: (useDecisionsFallback?: boolean) => Promise<any>;
    editCategories: (
      categories: Array<{
        id: string;
        name: string;
        description?: string;
        examples?: string[];
        sort?: number;
      }>,
    ) => Promise<any>;
    pending: (limit?: number) => Promise<{ count: number; items: PendingCategoryItem[] }>;
    confirmCategory: (itemId: string, categoryId: string) => Promise<any>;
  };
  sources: {
    loginCheck: (sourceId: string) => Promise<{ sourceId: string; status: string; message?: string }>;
    loginHandoff: (sourceId: string) => Promise<{ sourceId: string; status: string; message?: string }>;
    loginForget: (sourceId: string) => Promise<{ sourceId: string; status: string }>;
    sync: (sourceId: string, maxItems?: number) => Promise<any>;
  };
  chat: {
    listSessions: () => Promise<SessionRecord[]>;
    createSession: (title?: string) => Promise<SessionRecord>;
    getMessages: (sessionId: string) => Promise<AgentMessage[]>;
    searchMessages: (query: string, limit?: number) => Promise<SearchMessageHit[]>;
    sendMessage: (req: SendMessageRequest) => Promise<{ ok: boolean; error?: string }>;
    setWriteMode: (allowWrites: boolean) => Promise<{ allowWrites: boolean }>;
    onStreamEvent: (cb: (payload: ChatStreamPayload) => void) => () => void;
  };
  settings: {
    get: () => Promise<SafeSettingsPayload>;
    save: (patch: Partial<AppSettings>) => Promise<SafeSettingsPayload>;
    setApiKey: (apiKey: string) => Promise<SafeSettingsPayload>;
    checkEnv: () => Promise<EnvCheckResult>;
  };
  events: {
    onSyncProgress: (cb: (ev: SyncProgressEvent) => void) => () => void;
    onCollectionsChanged: (cb: (ev: CollectionsChangedEvent) => void) => () => void;
  };
  shell: {
    openExternal: (url: string) => Promise<{ ok: boolean }>;
  };
}

export type { A2uiSurfaceSpec, AgentMessage, AgentStreamEvent, ExpandedBookmarkItem, SessionRecord };
