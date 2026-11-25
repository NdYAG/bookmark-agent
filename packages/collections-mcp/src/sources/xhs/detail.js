// Runs inside a xiaohongshu.com note detail page (/explore/<id> or /user/profile/<uid>/<id>?xsec_token=...)
// to extract the full note title, body description (#detail-desc / .note-content), hashtags, publish date, and images.
// Reads only rendered DOM content: never cookies, storage, or network headers.
(() => {
  const textOf = (el) => (el ? (el.innerText || el.textContent || "").trim() : null);

  const titleEl =
    document.querySelector("#detail-title") ||
    document.querySelector(".note-content .title");
  const descEl =
    document.querySelector("#detail-desc") ||
    document.querySelector(".note-content .desc");
  const dateEl =
    document.querySelector(".bottom-container .date") ||
    document.querySelector(".note-content .date");
  const authorEl =
    document.querySelector(".author-container .username") ||
    document.querySelector(".author-wrapper .name");

  const tags = [...document.querySelectorAll("#detail-desc a.tag, .note-content a.tag")]
    .map((a) => textOf(a))
    .filter(Boolean);

  const images = [
    ...document.querySelectorAll(".media-container img, .swiper-slide img"),
  ]
    .map((img) => img.currentSrc || img.getAttribute("src"))
    .filter(Boolean);

  const uniqueImages = [...new Set(images)];

  const title = textOf(titleEl);
  const desc = textOf(descEl);
  const dateText = textOf(dateEl);
  const authorName = textOf(authorEl);

  const mainText = [title, desc, dateText ? `发布信息: ${dateText}` : null]
    .filter(Boolean)
    .join("\n\n");

  return {
    mainPost: {
      title,
      text: mainText || null,
      desc,
      dateText,
      authorName,
      tags,
      images: uniqueImages,
    },
    thread: mainText
      ? [{ id: null, text: mainText, quoteText: null }]
      : [],
    links: [],
  };
})()
