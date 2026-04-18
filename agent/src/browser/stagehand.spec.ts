import { describe, it, expect, vi, beforeEach } from "vitest";
import { Browser, toAgentTools } from "./stagehand.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("../llm/client.js", () => ({
  getLLMConfig: () => ({
    baseURL: "http://localhost:11434/v1",
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
        expect(result.value).toEqual([
          "https://example.com/about",
          "https://example.com/contact",
        ]);
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

describe("toAgentTools", () => {
  it("returns 5 tool definitions", () => {
    const tools = toAgentTools();
    expect(tools).toHaveLength(5);
  });

  it("includes expected tool names", () => {
    const tools = toAgentTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_act");
    expect(names).toContain("browser_extract");
    expect(names).toContain("browser_extract_text");
    expect(names).toContain("browser_observe");
  });

  it("each tool has name, description, and parameters", () => {
    const tools = toAgentTools();
    for (const tool of tools) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.description).toBeTypeOf("string");
      expect(tool.parameters).toBeDefined();
    }
  });
});
