// Runs inside the x.com page (agent-browser eval). Returns the bookmarks currently in the DOM.
// X virtualizes the list, so the caller scrolls and calls this repeatedly, deduplicating by id.
// Reads only rendered content: no cookies, storage, or network data.
(() => {
  const textOf = (el) => {
    if (!el) return null;
    let out = "";
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
      else if (n.nodeName === "IMG") out += n.getAttribute("alt") || ""; // emoji are <img alt="😀">
      else if (n.nodeName === "BR") out += "\n";
      else n.childNodes.forEach(walk);
    };
    walk(el);
    return out.trim();
  };

  const parseStatusHref = (href) => {
    const m = href && href.match(/^\/([^/]+)\/status\/(\d+)/);
    return m ? { handle: m[1], id: m[2] } : null;
  };

  // The quoted tweet sits in a nested div[role=link] that has its own author block.
  const quoteContainer = (article) =>
    [...article.querySelectorAll('div[role="link"]')].find((d) =>
      d.querySelector('[data-testid="User-Name"], time'),
    ) || null;

  // X renders a video's poster both as a tweetPhoto <img> and inside the video player, and GIFs/videos
  // use pbs.twimg.com/*_thumb paths. Classify by URL path and dedupe by path so each asset appears once.
  const mediaKind = (src) =>
    /\/(amplify_video_thumb|ext_tw_video_thumb)\//.test(src)
      ? "video"
      : /\/tweet_video_thumb\//.test(src)
        ? "gif"
        : "photo";
  const mediaIn = (root, exclude) => {
    const seen = new Map();
    const outside = (el) => !exclude || !exclude.contains(el);
    const add = (src, alt, isVideoContainer) => {
      if (!src) return;
      const key = src.split("?")[0];
      if (seen.has(key)) return;
      const kind = mediaKind(src);
      seen.set(key, { type: isVideoContainer && kind === "photo" ? "video" : kind, src, alt: alt || null });
    };
    root.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((img) => {
      if (outside(img)) add(img.currentSrc || img.src, img.alt, false);
    });
    root.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"]').forEach((v) => {
      if (!outside(v)) return;
      add(v.querySelector("video")?.getAttribute("poster") || v.querySelector("img")?.src, null, true);
    });
    return [...seen.values()];
  };

  const linksIn = (textEl) =>
    textEl
      ? [...textEl.querySelectorAll("a[href]")]
          .map((a) => ({ href: a.href, text: textOf(a) }))
          .filter((l) => !l.href.includes("/hashtag/") && !/^https:\/\/x\.com\/[^/]+$/.test(l.href))
      : [];

  const parseQuote = (q) => {
    if (!q) return null;
    const userName = q.querySelector('[data-testid="User-Name"]');
    const textEl = q.querySelector('[data-testid="tweetText"]');
    const handle = [...(userName?.querySelectorAll("span") || [])]
      .map((s) => s.textContent)
      .find((t) => t && t.startsWith("@"));
    return {
      author: { name: textOf(userName?.querySelector("span")) || null, handle: handle ? handle.slice(1) : null },
      time: q.querySelector("time")?.getAttribute("datetime") || null,
      text: textOf(textEl),
      media: mediaIn(q),
    };
  };

  // X long-form "Articles" have no tweetText; their title and preview are plain text next to a cover image.
  // Take the article's text minus the author line, avatar, timestamp and action bar.
  const articleText = (article) => {
    const clone = article.cloneNode(true);
    ['[data-testid="User-Name"]', '[data-testid="Tweet-User-Avatar"]', '[data-testid="caret"]', '[role="group"]', "time"].forEach(
      (sel) => clone.querySelectorAll(sel).forEach((n) => n.remove()),
    );
    return textOf(clone) || null;
  };

  const out = [];
  document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
    const quote = quoteContainer(article);
    const userName = [...article.querySelectorAll('[data-testid="User-Name"]')].find(
      (u) => !quote || !quote.contains(u),
    );
    const timeEl = userName?.querySelector("time");
    const link = timeEl?.closest("a");
    const ref = parseStatusHref(link?.getAttribute("href"));
    if (!ref) return; // ads or placeholders without a permalink

    const textEl = [...article.querySelectorAll('[data-testid="tweetText"]')].find(
      (t) => !quote || !quote.contains(t),
    );
    const card = article.querySelector('[data-testid="card.wrapper"]');
    out.push({
      id: ref.id,
      url: `https://x.com/${ref.handle}/status/${ref.id}`,
      author: { handle: ref.handle, name: textOf(userName?.querySelector("span")) || null },
      time: timeEl.getAttribute("datetime"),
      text: textOf(textEl),
      lang: textEl?.getAttribute("lang") || null,
      truncated: !!article.querySelector('[data-testid="tweet-text-show-more-link"]'),
      // X marks every bookmarked post in its action bar; this is how we know a row really is a bookmark.
      bookmarked: !!article.querySelector('[data-testid="removeBookmark"]'),
      // Diagnostic for posts that yield no text: what does the rendered article actually contain?
      rawText: textEl && textOf(textEl) ? undefined : (textOf(article) || "").slice(0, 300),
      kind: article.querySelector('[data-testid="article-cover-image"]') ? "article" : "post",
      articleText: article.querySelector('[data-testid="article-cover-image"]') ? articleText(article) : undefined,
      articleCover: article.querySelector('[data-testid="article-cover-image"] img')?.src ?? undefined,
      links: linksIn(textEl),
      media: mediaIn(article, quote),
      quote: parseQuote(quote),
      card: card
        ? { href: card.querySelector("a[href]")?.href || null, text: textOf(card) }
        : null,
    });
  });
  return out;
})()
