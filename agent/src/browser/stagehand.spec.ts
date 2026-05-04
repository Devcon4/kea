import { describe, it, expect, vi, beforeEach } from "vitest";
import { Browser } from "./stagehand.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("../pi/env.js", () => ({
  loadLlmEnv: () => ({
    baseUrl: "http://localhost:11434/v1",
    apiKey: "test-key",
    model: "test-model",
  }),
}));

const mockPage = {
  setViewportSize: vi.fn(),
  goto: vi.fn(),
  title: vi.fn().mockResolvedValue("Test Page"),
  url: vi.fn().mockReturnValue("https://example.com"),
  evaluate: vi.fn(),
  // Diagnostics plumbing: launch() injects an init script via CDP and
  // subscribes to console events. Mocks satisfy the call signatures so
  // unrelated tests don't trip over them.
  sendCDP: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("png")),
};

const mockInit = vi.fn();
const mockClose = vi.fn();
const mockAct = vi.fn();
const mockExtract = vi.fn();
const mockObserve = vi.fn();

vi.mock("@browserbasehq/stagehand", () => {
  return {
    Stagehand: class MockStagehand {
      context = { pages: () => [mockPage] };
      init = mockInit;
      close = mockClose;
      act = mockAct;
      extract = mockExtract;
      observe = mockObserve;
      constructor() {}
    },
  };
});

describe("Browser", () => {
  let browser: Browser;

  beforeEach(() => {
    vi.clearAllMocks();
    browser = new Browser();
  });

  describe("isLaunched", () => {
    it("returns false before launch", () => {
      expect(browser.isLaunched()).toBe(false);
    });
  });

  describe("launch", () => {
    it("initializes stagehand and sets viewport", async () => {
      const result = await browser.launch();

      expect(result.ok).toBe(true);
      expect(mockInit).toHaveBeenCalledOnce();
      expect(mockPage.setViewportSize).toHaveBeenCalledWith(1280, 720);
      expect(browser.isLaunched()).toBe(true);
    });

    it("accepts custom config", async () => {
      const result = await browser.launch({
        headless: false,
        viewport: { width: 800, height: 600 },
      });

      expect(result.ok).toBe(true);
      expect(mockPage.setViewportSize).toHaveBeenCalledWith(800, 600);
    });

    it("returns Err if already launched", async () => {
      await browser.launch();
      const result = await browser.launch();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("already launched");
      }
    });

    it("returns Err if init throws", async () => {
      mockInit.mockRejectedValueOnce(new Error("browser crash"));
      const fresh = new Browser();

      const result = await fresh.launch();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("browser crash");
      }
    });
  });

  describe("navigate", () => {
    it("returns Err when not launched", async () => {
      const result = await browser.navigate("https://example.com");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not launched");
      }
    });

    it("navigates to URL and returns page info", async () => {
      await browser.launch();

      mockPage.goto.mockResolvedValueOnce(undefined);
      mockPage.title.mockResolvedValueOnce("Example Page");
      mockPage.url.mockReturnValueOnce("https://example.com/page");

      const result = await browser.navigate("https://example.com/page");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.title).toBe("Example Page");
        expect(result.value.url).toBe("https://example.com/page");
      }
      expect(mockPage.goto).toHaveBeenCalledWith("https://example.com/page", {
        timeoutMs: 30_000,
      });
    });

    it("returns Err when navigation fails", async () => {
      await browser.launch();
      mockPage.goto.mockRejectedValueOnce(new Error("timeout"));

      const result = await browser.navigate("https://slow.com");
      expect(result.ok).toBe(false);
    });
  });

  describe("act", () => {
    it("returns Err when not launched", async () => {
      const result = await browser.act("click button");
      expect(result.ok).toBe(false);
    });

    it("performs action and returns outcome", async () => {
      await browser.launch();
      mockAct.mockResolvedValueOnce({
        success: true,
        actionDescription: "Clicked the submit button",
      });

      const result = await browser.act("click submit");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.success).toBe(true);
        expect(result.value.description).toBe("Clicked the submit button");
      }
    });

    it("handles missing actionDescription", async () => {
      await browser.launch();
      mockAct.mockResolvedValueOnce({
        success: true,
        actionDescription: undefined,
      });

      const result = await browser.act("do something");
      if (result.ok) {
        expect(result.value.description).toBe("");
      }
    });
  });

  describe("extract", () => {
    it("returns Err when not launched", async () => {
      const { z } = await import("zod");
      const result = await browser.extract("get title", z.object({ title: z.string() }));
      expect(result.ok).toBe(false);
    });

    it("extracts structured data", async () => {
      await browser.launch();
      const { z } = await import("zod");

      const schema = z.object({ title: z.string() });
      mockExtract.mockResolvedValueOnce({ title: "Hello" });

      const result = await browser.extract("get title", schema);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ title: "Hello" });
      }
    });
  });

  describe("extractText", () => {
    it("returns Err when not launched", async () => {
      const result = await browser.extractText();
      expect(result.ok).toBe(false);
    });

    it("extracts page text", async () => {
      await browser.launch();
      mockPage.evaluate.mockResolvedValueOnce("Hello World");

      const result = await browser.extractText();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("Hello World");
      }
    });
  });

  describe("extractLinks", () => {
    it("returns Err when not launched", async () => {
      const result = await browser.extractLinks();
      expect(result.ok).toBe(false);
    });

    it("extracts links from page DOM", async () => {
      await browser.launch();
      mockPage.evaluate.mockResolvedValueOnce([
        "https://example.com/about",
        "https://example.com/contact",
      ]);

      const result = await browser.extractLinks();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(["https://example.com/about", "https://example.com/contact"]);
      }
    });

    it("returns empty array when page has no links", async () => {
      await browser.launch();
      mockPage.evaluate.mockResolvedValueOnce([]);

      const result = await browser.extractLinks();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe("observe", () => {
    it("returns Err when not launched", async () => {
      const result = await browser.observe("look around");
      expect(result.ok).toBe(false);
    });

    it("returns observed actions", async () => {
      await browser.launch();
      mockObserve.mockResolvedValueOnce([
        {
          selector: "#btn",
          description: "Submit button",
          method: "click",
          arguments: [],
        },
        {
          selector: "input[name=q]",
          description: "Search input",
          method: "fill",
          arguments: ["query"],
        },
      ]);

      const result = await browser.observe("find interactive elements");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0].selector).toBe("#btn");
        expect(result.value[0].description).toBe("Submit button");
        expect(result.value[1].args).toEqual(["query"]);
      }
    });
  });

  describe("currentUrl", () => {
    it("returns empty string when not launched", () => {
      expect(browser.currentUrl()).toBe("");
    });

    it("returns current page URL when launched", async () => {
      await browser.launch();
      mockPage.url.mockReturnValueOnce("https://example.com/current");

      expect(browser.currentUrl()).toBe("https://example.com/current");
    });
  });

  describe("llm fetch interceptor", () => {
    it("records non-2xx responses to LLM_BASE_URL into captureDiagnostics", async () => {
      const original = globalThis.fetch;
      const native = vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : (input as { url: string }).url;
        if (url.startsWith("http://localhost:11434")) {
          return new Response(
            JSON.stringify({ error: "failed to load model vocabulary required for format" }),
            { status: 500, statusText: "Internal Server Error" },
          );
        }
        return new Response("", { status: 200 });
      });
      globalThis.fetch = native as unknown as typeof fetch;
      try {
        await browser.launch();

        const reqBody = JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] });
        const res = await globalThis.fetch("http://localhost:11434/v1/chat/completions", {
          method: "POST",
          body: reqBody,
        });
        expect(res.status).toBe(500);

        // Untracked traffic must pass through.
        await globalThis.fetch("http://other.example/ping", { method: "GET" });

        mockPage.evaluate.mockResolvedValueOnce({
          pageErrors: [],
          networkFailures: [],
          domSnippet: "",
          domTruncated: false,
        });
        const cap = await browser.captureDiagnostics({ failingStepIndex: 1 });
        expect(cap.ok).toBe(true);
        if (!cap.ok) return;
        expect(cap.value.diagnostics.llmFailures).toHaveLength(1);
        const f = cap.value.diagnostics.llmFailures[0];
        expect(f.url).toBe("http://localhost:11434/v1/chat/completions");
        expect(f.status).toBe(500);
        expect(f.requestBody).toBe(reqBody);
        expect(f.requestBodyTruncated).toBe(false);
        expect(f.responseBody).toContain("failed to load model vocabulary");
      } finally {
        await browser.close();
        globalThis.fetch = original;
      }
    });

    it("resetDiagnostics clears the buffer", async () => {
      const original = globalThis.fetch;
      globalThis.fetch = vi.fn(
        async () => new Response("err", { status: 500 }),
      ) as unknown as typeof fetch;
      try {
        await browser.launch();
        await globalThis.fetch("http://localhost:11434/v1/x", { method: "POST", body: "a" });
        await browser.resetDiagnostics();
        mockPage.evaluate.mockResolvedValueOnce({
          pageErrors: [],
          networkFailures: [],
          domSnippet: "",
          domTruncated: false,
        });
        const cap = await browser.captureDiagnostics({ failingStepIndex: null });
        expect(cap.ok).toBe(true);
        if (!cap.ok) return;
        expect(cap.value.diagnostics.llmFailures).toEqual([]);
      } finally {
        await browser.close();
        globalThis.fetch = original;
      }
    });
  });

  describe("close", () => {
    it("does nothing when not launched", async () => {
      await browser.close(); // should not throw
      expect(mockClose).not.toHaveBeenCalled();
    });

    it("closes stagehand and resets state", async () => {
      await browser.launch();
      await browser.close();

      expect(mockClose).toHaveBeenCalledOnce();
      expect(browser.isLaunched()).toBe(false);
    });
  });
});
