import type { BookmarkApi } from "../shared/types";

declare global {
  interface Window {
    bookmarkApi: BookmarkApi;
  }
}
