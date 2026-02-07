(async () => {
  const input = document.getElementById("search-input");
  const resultsEl = document.getElementById("search-results");
  if (!input || !resultsEl) return;

  const params = new URLSearchParams(window.location.search);
  const initialQuery = (params.get("q") || "").trim();
  input.value = initialQuery;

  const indexUrl = new URL("/index.json", window.location.origin).toString();
  const pages = await fetch(indexUrl, { cache: "no-store" })
    .then(r => (r.ok ? r.json() : []))
    .catch(() => []);

  const fuse = new Fuse(pages, {
    keys: [
      { name: "title", weight: 0.5 },
      { name: "summary", weight: 0.3 },
      { name: "content", weight: 0.2 },
      { name: "tags", weight: 0.1 },
      { name: "categories", weight: 0.1 }
    ],
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 2
  });

  const SNIPPET_LEN = 90;

  function render(query) {
    resultsEl.innerHTML = "";
    if (!query) return;

    const hits = fuse.search(query).slice(0, 30);
    if (!hits.length) {
      resultsEl.innerHTML = '<p class="search-empty">No results.</p>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const h of hits) {
      const item = h.item;

      const wrap = document.createElement("div");
      wrap.className = "search-item";

      const a = document.createElement("a");
      a.className = "search-title";
      a.href = item.permalink;
      a.textContent = item.title;

      const p = document.createElement("p");
      p.className = "search-snippet";

      const raw = (item.summary || item.content || "").replace(/\s+/g, " ").trim();
      const snippet = raw.length > SNIPPET_LEN ? raw.slice(0, SNIPPET_LEN) + "…" : raw;
      p.textContent = snippet;

      wrap.appendChild(a);
      wrap.appendChild(p);
      frag.appendChild(wrap);
    }

    resultsEl.appendChild(frag);

    if (window.Mark) {
      const marker = new Mark(resultsEl);
      marker.unmark({ done: () => marker.mark(query) });
    }
  }

  let t = null;
  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(t);
    t = setTimeout(() => render(q), 80);
  });

  render(initialQuery);
})();
