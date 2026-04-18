import { describe, it, expect } from "vitest";
import {
  createSession,
  completeSession,
  failSession,
  addFinding,
  visitPage,
  discoverPage,
  upsertPage,
  normalizeUrl,
} from "./domain.js";
import type { Session } from "@kea/shared";

// ── Helpers ────────────────────────────────────────────

function runningSession(overrides?: Partial<Session>): Session {
  return {
    id: "sess-1",
    targetUrl: "https://example.com/",
    status: "running",
    maxPages: 50,
    config: {},
    startedAt: 1000,
    completedAt: null,
    ...overrides,
  };
}

function completedSession(): Session {
  return runningSession({ status: "completed", completedAt: 2000 });
}

// ── normalizeUrl ───────────────────────────────────────

describe("normalizeUrl", () => {
  it("strips default ports", () => {
    expect(normalizeUrl("http://a.com:80/")).toBe("http://a.com/");
    expect(normalizeUrl("https://a.com:443/")).toBe("https://a.com/");
  });

  it("keeps non-default ports", () => {
    expect(normalizeUrl("http://a.com:8080/")).toBe("http://a.com:8080/");
  });

  it("returns invalid strings unchanged", () => {
    expect(normalizeUrl("not-a-url")).toBe("not-a-url");
  });
});

// ── createSession ──────────────────────────────────────

describe("createSession", () => {
  it("creates a valid session with defaults", () => {
    const r = createSession({
      id: "s1",
      targetUrl: "https://example.com",
      maxPages: 10,
      startedAt: 1000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("running");
    expect(r.value.completedAt).toBeNull();
    expect(r.value.config).toEqual({});
    expect(r.value.targetUrl).toBe("https://example.com/"); // normalized
  });

  it("rejects empty id", () => {
    const r = createSession({ id: "", targetUrl: "https://x.com", maxPages: 1, startedAt: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects empty targetUrl", () => {
    const r = createSession({ id: "s1", targetUrl: "", maxPages: 1, startedAt: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects maxPages < 1", () => {
    const r = createSession({ id: "s1", targetUrl: "https://x.com", maxPages: 0, startedAt: 1 });
    expect(r.ok).toBe(false);
  });
});

// ── completeSession / failSession ──────────────────────

describe("completeSession", () => {
  it("transitions running → completed", () => {
    const r = completeSession(runningSession(), 5000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("completed");
    expect(r.value.completedAt).toBe(5000);
  });

  it("rejects if already completed", () => {
    const r = completeSession(completedSession());
    expect(r.ok).toBe(false);
  });
});

describe("failSession", () => {
  it("transitions running → failed", () => {
    const r = failSession(runningSession(), 5000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("failed");
    expect(r.value.completedAt).toBe(5000);
  });

  it("rejects if already completed", () => {
    const r = failSession(completedSession());
    expect(r.ok).toBe(false);
  });
});

// ── addFinding ─────────────────────────────────────────

describe("addFinding", () => {
  const input = {
    url: "https://example.com/page",
    agentId: "tester",
    action: "click button",
    result: "404 error",
    severity: "error" as const,
    timestamp: 3000,
  };

  it("creates a finding for a running session", () => {
    const r = addFinding(runningSession(), input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionId).toBe("sess-1");
    expect(r.value.severity).toBe("error");
    expect(r.value.url).toBe("https://example.com/page"); // normalized
  });

  it("rejects if session is completed", () => {
    const r = addFinding(completedSession(), input);
    expect(r.ok).toBe(false);
  });

  it("rejects if url is empty", () => {
    const r = addFinding(runningSession(), { ...input, url: "" });
    expect(r.ok).toBe(false);
  });
});

// ── visitPage ──────────────────────────────────────────

describe("visitPage", () => {
  it("creates a visited sitemap entry", () => {
    const r = visitPage(runningSession(), {
      url: "https://example.com/about",
      title: "About",
      links: ["/contact"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("visited");
    expect(r.value.visitedAt).not.toBeNull();
    expect(r.value.url).toBe("https://example.com/about");
  });

  it("rejects if session is not running", () => {
    const r = visitPage(completedSession(), {
      url: "https://example.com",
      title: "hi",
      links: [],
    });
    expect(r.ok).toBe(false);
  });
});

// ── discoverPage ───────────────────────────────────────

describe("discoverPage", () => {
  it("creates a discovered sitemap entry", () => {
    const r = discoverPage(runningSession(), "https://example.com/new");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("discovered");
    expect(r.value.visitedAt).toBeNull();
    expect(r.value.title).toBe("");
  });

  it("rejects if session is not running", () => {
    const r = discoverPage(completedSession(), "https://x.com");
    expect(r.ok).toBe(false);
  });
});

// ── upsertPage ─────────────────────────────────────────

describe("upsertPage", () => {
  it("creates a sitemap entry with given status", () => {
    const r = upsertPage(runningSession(), {
      url: "https://example.com/tested",
      title: "Tested",
      links: [],
      status: "tested",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("tested");
  });

  it("normalizes the URL", () => {
    const r = upsertPage(runningSession(), {
      url: "https://example.com:443/page",
      title: "",
      links: [],
      status: "discovered",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.url).toBe("https://example.com/page");
  });

  it("rejects if session is not running", () => {
    const r = upsertPage(completedSession(), {
      url: "https://x.com",
      title: "",
      links: [],
      status: "discovered",
    });
    expect(r.ok).toBe(false);
  });
});
