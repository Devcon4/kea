/**
 * Static page discovery — Node-side HTTP fetch + HTML walk.
 *
 * Why static, not browser-driven:
 *   - Discovery is enumeration of URL-bearing surfaces, not interaction.
 *     An LLM is the wrong tool for "what links does this HTML contain".
 *   - The coordinator previously called `Browser.extractLinks`, which evaluates
 *     a string IIFE through Stagehand's CDP-backed `Runtime.evaluate`. In this
 *     deployment that throws `StagehandEvalError: Uncaught` and silently
 *     yields zero links, leaving sitemaps stuck at one entry. HTTP fetch is
 *     deterministic, free, and immune to that failure mode.
 *   - For SPA shells whose entry HTML has no anchors (e.g. Vite/Vue forms),
 *     `discoverFromSitemap()` covers the gap by reading `sitemap.xml` and
 *     `robots.txt` `Sitemap:` directives.
 *
 * Beyond plain `<a href>` we also pull URL-bearing attributes from non-anchor
 * controls so that button-driven sites (HTMX, GET forms, `data-href`, inline
 * `location.href` handlers) still produce a useful sitemap. URLs that need a
 * click to materialize (pure JS routers, fetch-on-click) are out of scope —
 * those require an interactive pass and belong to a future tool.
 */

const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "data-href",
  "data-url",
  "data-link",
  "hx-get",
  "hx-post",
  "hx-put",
  "hx-delete",
  "hx-patch",
  "formaction",
]);

const ONCLICK_URL_RE =
  /(?:location(?:\.href)?|window\.location(?:\.href)?)\s*=\s*['"]([^'"]+)['"]/g;

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const ATTR_RE = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>]+))/g;

const HTTP_TIMEOUT_MS = 10_000;

export type DiscoverySource = "anchor" | "form" | "data-attr" | "onclick";

export type DiscoveredUrl = {
  url: string;
  source: DiscoverySource;
};

export type FetchedPage = {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
};

/** Fetch a URL with a hard timeout. Returns null on transport error. */
export async function fetchPage(url: string): Promise<FetchedPage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "kea-agent/0.1 static-discover" },
    });
    const body = await res.text();
    return {
      url: res.url || url,
      status: res.status,
      contentType: res.headers.get("content-type"),
      body,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the HTML of `pageUrl` and return every URL-bearing attribute target,
 * resolved against `pageUrl` and filtered to same-origin http(s) URLs.
 */
export function extractUrlsFromHtml(html: string, pageUrl: string): DiscoveredUrl[] {
  const base = safeURL(pageUrl);
  if (!base) return [];

  const out: DiscoveredUrl[] = [];
  const seen = new Set<string>();

  const consider = (raw: string | undefined, source: DiscoverySource) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("#")) return;
    if (/^(javascript|mailto|tel|data):/i.test(trimmed)) return;
    let resolved: URL;
    try {
      resolved = new URL(trimmed, base);
    } catch {
      return;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    if (resolved.origin !== base.origin) return;
    resolved.hash = "";
    const key = `${source}|${resolved.toString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: resolved.toString(), source });
  };

  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const isAnchor = tag === "a";
    const isForm = tag === "form";

    ATTR_RE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(attrs)) !== null) {
      const name = attrMatch[1].toLowerCase();
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];

      if (URL_ATTRS.has(name)) {
        // Skip <img src> / <script src> / <link href stylesheet> — those are
        // assets, not navigable surfaces. Restrict by tag/attr combo.
        if (name === "src") continue;
        if (name === "href" && tag === "link") continue;
        const source: DiscoverySource = isAnchor
          ? "anchor"
          : isForm
            ? "form"
            : "data-attr";
        consider(value, source);
      }

      if (name === "onclick" && value) {
        ONCLICK_URL_RE.lastIndex = 0;
        let onclickMatch: RegExpExecArray | null;
        while ((onclickMatch = ONCLICK_URL_RE.exec(value)) !== null) {
          consider(onclickMatch[1], "onclick");
        }
      }
    }
  }

  return out;
}

/**
 * Discover URLs from a remote page by HTTP-fetching it and walking the HTML.
 * Returns same-origin http(s) URLs paired with the source attribute that
 * produced them.
 */
export async function discoverPageLinks(pageUrl: string): Promise<{
  fetched: FetchedPage | null;
  urls: DiscoveredUrl[];
}> {
  const fetched = await fetchPage(pageUrl);
  if (!fetched || !fetched.contentType?.toLowerCase().includes("html")) {
    return { fetched, urls: [] };
  }
  const urls = extractUrlsFromHtml(fetched.body, fetched.url);
  return { fetched, urls };
}

/**
 * Discover URLs from `sitemap.xml`, `sitemap_index.xml`, and any `Sitemap:`
 * directives in `robots.txt`. Returns same-origin http(s) URLs.
 *
 * This runs once per session bootstrap so a freshly created session starts
 * with a complete enumeration of advertised pages, even when the entry page
 * is a JS-shell SPA whose static HTML has no anchors.
 */
export async function discoverFromSitemap(targetOrigin: string): Promise<string[]> {
  const origin = safeURL(targetOrigin);
  if (!origin) return [];

  const sitemapUrls = new Set<string>([
    `${origin.origin}/sitemap.xml`,
    `${origin.origin}/sitemap_index.xml`,
  ]);

  const robots = await fetchPage(`${origin.origin}/robots.txt`);
  if (robots && robots.status === 200) {
    for (const line of robots.body.split(/\r?\n/)) {
      const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
      if (m) sitemapUrls.add(m[1]);
    }
  }

  const out = new Set<string>();
  for (const candidate of sitemapUrls) {
    await harvestSitemap(candidate, origin.origin, out, new Set<string>());
  }
  return [...out];
}

async function harvestSitemap(
  url: string,
  expectedOrigin: string,
  acc: Set<string>,
  visited: Set<string>,
): Promise<void> {
  if (visited.has(url)) return;
  visited.add(url);

  const fetched = await fetchPage(url);
  if (!fetched || fetched.status !== 200) return;

  const ct = (fetched.contentType ?? "").toLowerCase();
  if (!ct.includes("xml") && !ct.includes("text")) return;

  const locs = [...fetched.body.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) =>
    m[1].trim(),
  );
  if (locs.length === 0) return;

  const isIndex = /<sitemapindex/i.test(fetched.body);
  for (const loc of locs) {
    let resolved: URL;
    try {
      resolved = new URL(loc);
    } catch {
      continue;
    }
    if (resolved.origin !== expectedOrigin) continue;
    if (isIndex) {
      await harvestSitemap(resolved.toString(), expectedOrigin, acc, visited);
    } else {
      acc.add(resolved.toString());
    }
  }
}

function safeURL(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
