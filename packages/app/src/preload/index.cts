const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel: string, cb: (payload: any) => void) {
  const listener = (_event: any, payload: any) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  items: {
    list: (params: any) => ipcRenderer.invoke("items:list", params),
    update: (id: string, patch: any) => ipcRenderer.invoke("items:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("items:remove", id),
    related: (id: string, k?: number, mode?: string) =>
      ipcRenderer.invoke("items:related", id, k, mode),
    dismissRelated: (targetId: string, candidateId: string) =>
      ipcRenderer.invoke("items:dismissRelated", targetId, candidateId),
    resolveCover: (remoteUrl: string) => ipcRenderer.invoke("items:resolveCover", remoteUrl),
  },
  meta: {
    get: () => ipcRenderer.invoke("meta:get"),
    proposeTaxonomy: (useDecisionsFallback?: boolean) =>
      ipcRenderer.invoke("meta:proposeTaxonomy", useDecisionsFallback),
    editCategories: (categories: any[]) => ipcRenderer.invoke("meta:editCategories", categories),
    pending: (limit?: number) => ipcRenderer.invoke("meta:pending", limit),
    confirmCategory: (itemId: string, categoryId: string) =>
      ipcRenderer.invoke("meta:confirmCategory", itemId, categoryId),
  },
  sources: {
    loginCheck: (sourceId: string) => ipcRenderer.invoke("sources:loginCheck", sourceId),
    loginHandoff: (sourceId: string) => ipcRenderer.invoke("sources:loginHandoff", sourceId),
    loginForget: (sourceId: string) => ipcRenderer.invoke("sources:loginForget", sourceId),
    sync: (sourceId: string, maxItems?: number) =>
      ipcRenderer.invoke("sources:sync", sourceId, maxItems),
  },
  chat: {
    listSessions: () => ipcRenderer.invoke("chat:listSessions"),
    createSession: (title?: string) => ipcRenderer.invoke("chat:createSession", title),
    getMessages: (sessionId: string) => ipcRenderer.invoke("chat:getMessages", sessionId),
    searchMessages: (query: string, limit?: number) =>
      ipcRenderer.invoke("chat:searchMessages", query, limit),
    sendMessage: (req: any) => ipcRenderer.invoke("chat:sendMessage", req),
    setWriteMode: (allowWrites: boolean) => ipcRenderer.invoke("chat:setWriteMode", allowWrites),
    onStreamEvent: (cb: (payload: any) => void) => subscribe("chat:stream", cb),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (patch: any) => ipcRenderer.invoke("settings:save", patch),
    setApiKey: (apiKey: string) => ipcRenderer.invoke("settings:setApiKey", apiKey),
    checkEnv: () => ipcRenderer.invoke("settings:checkEnv"),
  },
  events: {
    onSyncProgress: (cb: (ev: any) => void) => subscribe("sync:progress", cb),
    onCollectionsChanged: (cb: (ev: any) => void) => subscribe("collections:changed", cb),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  },
};

contextBridge.exposeInMainWorld("bookmarkApi", api);
