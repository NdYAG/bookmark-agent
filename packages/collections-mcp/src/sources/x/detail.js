// Runs inside an x.com/<handle>/status/<id> detail page to extract full untruncated tweet text,
// author thread posts, long-form X Article body, quoted tweet, and external link cards.
// Reads only rendered DOM content: never cookies, storage, or network headers.
(() => {
  const textOf = (el) => {
    if (!el) return null;
    let out = "";
    const walk = (n) => {
      if (n.nodeType === 3) out += n.nodeValue || "";
      else if (n.nodeName === "IMG") out += n.getAttribute("alt") || "";
      else if (n.nodeName === "BR") out += "\n";
      else if (n.childNodes) n.childNodes.forEach(walk);
    };
    walk(el);
    return out.trim();
  };

  const parseStatusHref = (href) => {
    const m = href && href.match(/\/([^/]+)\/status\/(\d+)/);
    return m ? { handle: m[1], id: m[2] } : null;
  };

  const quoteContainer = (article) =>
    [...article.querySelectorAll('div[role="link"]')].find((d) =>
      d.querySelector('[data-testid="User-Name"], time'),
    ) || null;

  const linksIn = (root) =>
    root
      ? [...root.querySelectorAll("a[href]")]
          .map((a) => ({ href: a.href || a.getAttribute("href"), text: textOf(a) }))
          .filter(
            (l) =>
              l.href &&
              !l.href.includes("/hashtag/") &&
              !/^https:\/\/x\.com\/[^/]+$/.test(l.href) &&
              !/\/status\/\d+/.test(l.href),
          )
      : [];

  const posts = [];
  document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
    const quote = quoteContainer(article);
    const userName = [...article.querySelectorAll('[data-testid="User-Name"]')].find(
      (u) => !quote || !quote.contains(u),
    );
    const handleSpan = [...(userName?.querySelectorAll("span") || [])]
      .map((s) => s.textContent)
      .find((t) => t && t.startsWith("@"));
    const handle = handleSpan ? handleSpan.slice(1) : null;
    const timeEl = article.querySelector("time");
    const link = timeEl?.closest("a");
    const ref = parseStatusHref(link?.getAttribute("href"));

    const textEl = [...article.querySelectorAll('[data-testid="tweetText"]')].find(
      (t) => !quote || !quote.contains(t),
    );
    const longArticleBody =
      article.querySelector('[data-testid="twitterArticleRichTextView"]') ||
      article.querySelector('[data-testid="longformRichTextComponent"]');

    const card = article.querySelector('[data-testid="card.wrapper"]');
    const quoteTextEl = quote?.querySelector('[data-testid="tweetText"]');

    posts.push({
      id: ref?.id || null,
      handle: ref?.handle || handle,
      authorName: textOf(userName?.querySelector("span")) || null,
      time: timeEl?.getAttribute("datetime") || null,
      text: textOf(longArticleBody) || textOf(textEl) || null,
      quoteText: quoteTextEl ? textOf(quoteTextEl) : null,
      card: card
        ? {
            href:
              card.querySelector("a[href]")?.href ||
              card.querySelector("a[href]")?.getAttribute("href") ||
              null,
            text: textOf(card),
          }
        : null,
      links: linksIn(textEl || article),
    });
  });

  if (posts.length === 0) {
    return { mainPost: null, thread: [], links: [] };
  }

  const mainAuthor = posts[0].handle;
  const thread = [];
  for (const p of posts) {
    if (mainAuthor && p.handle && p.handle.toLowerCase() === mainAuthor.toLowerCase()) {
      thread.push(p);
    } else if (thread.length > 0) {
      // Stop once replies from other users begin
      break;
    }
  }

  const allLinks = [];
  const seenHrefs = new Set();
  for (const p of thread) {
    for (const l of p.links || []) {
      if (l.href && !seenHrefs.has(l.href)) {
        seenHrefs.add(l.href);
        allLinks.push(l);
      }
    }
    if (p.card?.href && !seenHrefs.has(p.card.href)) {
      seenHrefs.add(p.card.href);
      allLinks.push({ href: p.card.href, text: p.card.text || p.card.href });
    }
  }

  return {
    mainPost: posts[0],
    thread,
    links: allLinks,
  };
})()
