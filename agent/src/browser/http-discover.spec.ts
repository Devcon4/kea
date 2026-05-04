import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractUrlsFromHtml, discoverFromSitemap, discoverPageLinks } from "./http-discover.js";

describe("extractUrlsFromHtml", () => {
  const base = "http://blog/";

  it("collects anchor hrefs", () => {
    const html = `
      <a href="/about.html">About</a>
      <a href="/posts.html#latest">Posts</a>
      <a href="http://blog/contact.html">Contact</a>
    `;
    const urls = extractUrlsFromHtml(html, base);
    expect(urls.map((u) => u.url).sort()).toEqual([
      "http://blog/about.html",
      "http://blog/contact.html",
      "http://blog/posts.html",
    ]);
    expect(urls.every((u) => u.source === "anchor")).toBe(true);
  });

  it("collects form actions and HTMX/data-href attributes", () => {
    const html = `
      <form action="/search" method="get"><input name="q"></form>
      <button data-href="/cart">Cart</button>
      <div hx-get="/api/items">Load</div>
      <a href="/home">Home</a>
    `;
    const urls = extractUrlsFromHtml(html, base);
    const bySource = urls.reduce<Record<string, number>>((acc, u) => {
      acc[u.source] = (acc[u.source] ?? 0) + 1;
      return acc;
    }, {});
    expect(bySource).toEqual({ anchor: 1, form: 1, "data-attr": 2 });
    expect(urls.map((u) => u.url).sort()).toEqual([
      "http://blog/api/items",
      "http://blog/cart",
      "http://blog/home",
      "http://blog/search",
    ]);
  });

  it("collects URLs from inline onclick location.href patterns", () => {
    const html = `
      <button onclick="location.href='/checkout'">Checkout</button>
      <button onclick="window.location = '/cart'">Cart</button>
    `;
    const urls = extractUrlsFromHtml(html, base);
    expect(urls.every((u) => u.source === "onclick")).toBe(true);
    expect(urls.map((u) => u.url).sort()).toEqual([
      "http://blog/cart",
      "http://blog/checkout",
    ]);
  });

  it("rejects cross-origin, javascript:, mailto:, tel:, data:, hash-only, and asset URLs", () => {
    const html = `
      <a href="https://other.example/x">cross-origin</a>
      <a href="javascript:alert(1)">js</a>
      <a href="mailto:a@b">mail</a>
      <a href="tel:123">tel</a>
      <a href="#nav">hash</a>
      <link href="/styles.css" rel="stylesheet">
      <img src="/img.png">
      <script src="/x.js"></script>
      <a href="/keep">ok</a>
    `;
    const urls = extractUrlsFromHtml(html, base);
    expect(urls.map((u) => u.url)).toEqual(["http://blog/keep"]);
  });

  it("dedupes the same (source, url) pair but keeps duplicates from different sources", () => {
    const html = `
      <a href="/x">first</a>
      <a href="/x">again</a>
      <button data-href="/x">also-x</button>
    `;
    const urls = extractUrlsFromHtml(html, base);
    expect(urls).toEqual([
      { url: "http://blog/x", source: "anchor" },
      { url: "http://blog/x", source: "data-attr" },
    ]);
  });

  it("returns [] for an unparseable base URL", () => {
    expect(extractUrlsFromHtml("<a href='/x'>x</a>", "::not a url::")).toEqual([]);
  });
});

describe("discoverFromSitemap", () => {
  const realFetch = globalThis.fetch;
  const responses = new Map<string, { status: number; body: string; contentType: string }>();

  beforeEach(() => {
    responses.clear();
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const r = responses.get(url);
      if (!r) {
        return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
      }
      return new Response(r.body, {
        status: r.status,
        headers: { "content-type": r.contentType },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reads sitemap.xml and returns same-origin URLs", async () => {
    responses.set("http://blog/sitemap.xml", {
      status: 200,
      contentType: "application/xml",
      body: `<?xml version="1.0"?>
        <urlset>
          <url><loc>http://blog/about.html</loc></url>
          <url><loc>http://blog/posts.html</loc></url>
          <url><loc>https://other.example/skip</loc></url>
        </urlset>`,
    });
    const urls = await discoverFromSitemap("http://blog/");
    expect(urls.sort()).toEqual(["http://blog/about.html", "http://blog/posts.html"]);
  });

  it("follows sitemap-index entries one level deep", async () => {
    responses.set("http://blog/sitemap.xml", {
      status: 200,
      contentType: "application/xml",
      body: `<sitemapindex>
        <sitemap><loc>http://blog/maps/posts.xml</loc></sitemap>
      </sitemapindex>`,
    });
    responses.set("http://blog/maps/posts.xml", {
      status: 200,
      contentType: "application/xml",
      body: `<urlset>
        <url><loc>http://blog/post-1.html</loc></url>
      </urlset>`,
    });
    const urls = await discoverFromSitemap("http://blog/");
    expect(urls).toEqual(["http://blog/post-1.html"]);
  });

  it("respects Sitemap: directives in robots.txt", async () => {
    responses.set("http://blog/robots.txt", {
      status: 200,
      contentType: "text/plain",
      body: "User-agent: *\nSitemap: http://blog/maps/main.xml\n",
    });
    responses.set("http://blog/maps/main.xml", {
      status: 200,
      contentType: "application/xml",
      body: `<urlset><url><loc>http://blog/contact.html</loc></url></urlset>`,
    });
    const urls = await discoverFromSitemap("http://blog/");
    expect(urls).toEqual(["http://blog/contact.html"]);
  });

  it("returns [] when no sitemap is published", async () => {
    const urls = await discoverFromSitemap("http://blog/");
    expect(urls).toEqual([]);
  });
});

describe("discoverPageLinks", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns [] when the response is non-HTML", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("plain text", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    ) as typeof fetch;
    const result = await discoverPageLinks("http://blog/feed");
    expect(result.urls).toEqual([]);
    expect(result.fetched?.status).toBe(200);
  });

  it("parses HTML responses into discovered URLs", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(`<html><body><a href="/about">A</a></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ) as typeof fetch;
    const result = await discoverPageLinks("http://blog/");
    expect(result.urls).toEqual([{ url: "http://blog/about", source: "anchor" }]);
  });
});
