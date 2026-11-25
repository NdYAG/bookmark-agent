// Runs inside the xiaohongshu.com user profile favorites page (agent-browser eval).
// Extracts the bookmarked notes currently in the DOM under the "收藏" tab container
// (specifically excluding `#userPostedFeeds` which holds the user's own posted notes).
// Reads only rendered DOM content: no cookies, storage, or network headers.
(() => {
  const textOf = (el) => (el ? (el.innerText || el.textContent || "").trim() : null);

  // Locate the favorites tab content container:
  // On Xiaohongshu profile pages, `.tab-content-item` #0 is `#userPostedFeeds` (user's own posts),
  // and the `.tab-content-item` containing `.sub-tab-list` (or the second `.tab-content-item`) is "收藏".
  const tabContents = [...document.querySelectorAll(".tab-content-item")];
  const favContainer =
    tabContents.find((el) => el.querySelector(".sub-tab-list")) ||
    tabContents.find((el) => !el.querySelector("#userPostedFeeds") && el.querySelector("section.note-item")) ||
    null;

  if (!favContainer) return [];

  const parseAuthorId = (href) => {
    if (!href) return null;
    const m = href.match(/\/user\/profile\/([0-9a-fA-F]{16,32})/);
    return m ? m[1] : null;
  };

  const out = [];
  const items = [...favContainer.querySelectorAll("section.note-item")];

  // Sort by data-index so items are returned in exact collection order (newest bookmarked first)
  items.sort((a, b) => {
    const ia = Number(a.getAttribute("data-index") ?? 0);
    const ib = Number(b.getAttribute("data-index") ?? 0);
    return ia - ib;
  });

  for (const section of items) {
    // Double-check it is not inside #userPostedFeeds
    if (section.closest("#userPostedFeeds")) continue;

    const noteId =
      section.getAttribute("data-note-id") ||
      section
        .querySelector('a[href*="/explore/"]')
        ?.getAttribute("href")
        ?.match(/\/explore\/([0-9a-fA-F]+)/)?.[1] ||
      null;
    if (!noteId) continue;

    const dataIndexAttr = section.getAttribute("data-index");
    const dataIndex = dataIndexAttr !== null ? Number(dataIndexAttr) : null;

    const coverAnchor = section.querySelector("a.cover");
    const rawCoverHref = coverAnchor?.getAttribute("href") || null;
    const fullUrl = rawCoverHref
      ? new URL(rawCoverHref, location.origin).toString()
      : `https://www.xiaohongshu.com/explore/${noteId}`;
    const canonicalUrl = `https://www.xiaohongshu.com/explore/${noteId}`;

    const coverImgEl = coverAnchor?.querySelector("img");
    const coverSrc = coverImgEl?.currentSrc || coverImgEl?.getAttribute("src") || null;
    const width = Number(section.getAttribute("data-width")) || null;
    const height = Number(section.getAttribute("data-height")) || null;

    const isVideo = Boolean(
      section.querySelector('.play-icon, svg use[href*="play"], svg use[href*="video"]'),
    );

    const titleEl = section.querySelector(".footer .title, a.title");
    const title = textOf(titleEl) || null;

    const authorAnchor = section.querySelector(".author-wrapper a.author, a.author");
    const authorHref = authorAnchor?.getAttribute("href") || null;
    const authorId = parseAuthorId(authorHref);
    const authorName = textOf(authorAnchor?.querySelector(".name")) || textOf(authorAnchor) || null;
    const authorAvatar =
      authorAnchor?.querySelector("img.author-avatar, img")?.getAttribute("src") || null;

    // In Xiaohongshu's favorites tab, every author link carries `xsec_source=pc_collect`
    const bookmarked = Boolean(
      (authorHref && authorHref.includes("xsec_source=pc_collect")) ||
        favContainer.contains(section),
    );

    const likesText = textOf(section.querySelector(".like-wrapper .count")) || null;

    const media = coverSrc
      ? [
          {
            type: isVideo ? "video" : "photo",
            src: coverSrc,
            alt: title,
            width,
            height,
          },
        ]
      : [];

    out.push({
      id: noteId,
      dataIndex,
      url: fullUrl,
      canonicalUrl,
      title,
      text: title, // List card displays title; full note description is fetched on demand via detail.js
      author: {
        id: authorId,
        handle: authorId,
        name: authorName,
        avatar: authorAvatar,
        profileUrl: authorHref ? new URL(authorHref, location.origin).toString() : null,
      },
      kind: isVideo ? "video" : "post",
      bookmarked,
      likes: likesText,
      media,
    });
  }

  return out;
})()
