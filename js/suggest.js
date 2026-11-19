let counter = 0;

/**
 * YouTube search-box autocomplete. The endpoint sends no CORS headers, so it can't be
 * fetched; it only supports JSONP, loaded through a <script> tag. It needs no API key
 * and doesn't count against the Data API quota. Resolves to [] on any failure/timeout.
 */
export function fetchSuggestions(query, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const callbackName = `__ytSuggest${++counter}`;
    const script = document.createElement("script");
    let settled = false;

    const cleanup = () => {
      delete window[callbackName];
      script.remove();
    };
    const finish = (list) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(list);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window[callbackName] = cleanup; // a late response just cleans up after itself
      resolve([]);
    }, timeoutMs);

    window[callbackName] = (data) => {
      const entries = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
      finish(entries.map((entry) => (Array.isArray(entry) ? entry[0] : entry)).filter((text) => typeof text === "string"));
    };
    script.onerror = () => finish([]);
    script.src =
      "https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&hl=ko&ie=utf-8&oe=utf-8" +
      `&q=${encodeURIComponent(query)}&jsonp=${callbackName}`;
    document.head.appendChild(script);
  });
}
