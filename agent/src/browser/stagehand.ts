import { Stagehand } from "@browserbasehq/stagehand";
import { z, type ZodTypeAny } from "zod";
import { Ok, Err, tryCatch } from "../result.js";
import type { Result } from "../result.js";
import { createLogger } from "../logger.js";
import { getLLMConfig } from "../llm/client.js";
import type { ToolDefinition } from "../llm/client.js";

const log = createLogger("browser");

export type BrowserConfig = {
  headless?: boolean;
  viewport?: { width: number; height: number };
  timeout?: number;
};

export type PageInfo = {
  url: string;
  title: string;
};

export type ActOutcome = {
  success: boolean;
  description: string;
};

export type ObservedAction = {
  selector: string;
  description: string;
  method?: string;
  args?: string[];
};

export class Browser {
  private stagehand: Stagehand | null = null;
  private config: Required<BrowserConfig> = {
    headless: true,
    viewport: { width: 1280, height: 720 },
    timeout: 30_000,
  };

  async launch(config?: BrowserConfig): Promise<Result<void, Error>> {
    if (this.stagehand) return Err(new Error("browser already launched"));

    this.config = { ...this.config, ...config };
    const llm = getLLMConfig();

    log.info({ headless: this.config.headless, model: llm.model }, "launching browser");

    return tryCatch(async () => {
      const stagehand = new Stagehand({
        env: "LOCAL",
        model: {
          modelName: `openai/${llm.model}`,
          apiKey: llm.apiKey,
          baseURL: llm.baseURL,
        },
        localBrowserLaunchOptions: {
          headless: this.config.headless,
          executablePath: process.env.CHROME_PATH,
          args: [
            "--no-sandbox",
            "--disable-gpu",
          ],
        },
        verbose: 0,
        selfHeal: true,
      });

      await stagehand.init();

      const page = stagehand.context.pages()[0];
      if (this.config.viewport) {
        await page.setViewportSize(this.config.viewport.width, this.config.viewport.height);
      }

      this.stagehand = stagehand;
    });
  }

  async navigate(url: string): Promise<Result<PageInfo, Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));

    const page = this.stagehand.context.pages()[0];

    return tryCatch(async () => {
      await page.goto(url, { timeoutMs: this.config.timeout });
      await this.waitForSettled();
      const title = await page.title();
      return { url: page.url(), title };
    });
  }

  /**
   * Wait for SPA / Web Component pages to finish rendering.
   * Waits for pending custom element upgrades, then two animation frames
   * plus a microtask flush so shadow roots are populated.
   */
  private async waitForSettled(): Promise<void> {
    if (!this.stagehand) return;
    const page = this.stagehand.context.pages()[0];
    await page.evaluate(`
      new Promise(resolve => {
        // Wait for any :not(:defined) custom elements to upgrade
        const undefinedEls = document.querySelectorAll(':not(:defined)');
        const promises = [...undefinedEls].map(el =>
          customElements.whenDefined(el.localName)
        );
        Promise.all(promises).then(() => {
          // Two rAF + microtask to let Lit/etc render into shadow roots
          requestAnimationFrame(() => requestAnimationFrame(() => {
            Promise.resolve().then(resolve);
          }));
        });
        // Safety timeout so we don't hang on broken components
        setTimeout(resolve, 3000);
      })
    `);
  }

  async act(instruction: string): Promise<Result<ActOutcome, Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));

    log.debug({ instruction }, "browser act");

    return tryCatch(async () => {
      const result = await this.stagehand!.act(instruction);
      return {
        success: result.success,
        description: result.actionDescription ?? "",
      };
    });
  }

  async extract<T>(instruction: string, schema: ZodTypeAny): Promise<Result<T, Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));

    log.debug({ instruction }, "browser extract");

    return tryCatch(async () => {
      return this.stagehand!.extract(instruction, schema) as Promise<T>;
    });
  }

  /** Extract visible text content, traversing into Shadow DOM roots. */
  async extractText(): Promise<Result<string, Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));

    return tryCatch(async () => {
      const page = this.stagehand!.context.pages()[0];
      const text = await page.evaluate(`
        (function() {
          const parts = [];
          function walk(root) {
            for (const node of root.childNodes) {
              if (node.nodeType === Node.TEXT_NODE) {
                const t = node.textContent.trim();
                if (t) parts.push(t);
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node;
                const tag = el.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
                if (el.shadowRoot) walk(el.shadowRoot);
                walk(el);
              }
            }
          }
          walk(document.body);
          return parts.join('\\n');
        })()
      `);
      return text as string;
    });
  }

  /**
   * Extract all links from the DOM, including inside Shadow DOM roots.
   * Finds both <a href> elements AND URL patterns in visible text.
   */
  async extractLinks(): Promise<Result<string[], Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));

    return tryCatch(async () => {
      const page = this.stagehand!.context.pages()[0];
      const links = await page.evaluate(`
        (function() {
          const hrefs = new Set();
          const urlRe = /https?:\/\/[^\\s"'<>)\\]]+/g;

          function walkLinks(root) {
            for (const a of root.querySelectorAll('a[href]')) {
              if (a.href && a.href.startsWith('http')) hrefs.add(a.href);
            }
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) walkLinks(el.shadowRoot);
            }
          }

          function walkText(root) {
            for (const node of root.childNodes) {
              if (node.nodeType === Node.TEXT_NODE) {
                const matches = node.textContent.match(urlRe);
                if (matches) matches.forEach(u => hrefs.add(u));
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
                if (node.shadowRoot) walkText(node.shadowRoot);
                walkText(node);
              }
            }
          }

          walkLinks(document);
          walkText(document.body);
          return [...hrefs];
        })()
      `);
      return links as string[];
    });
  }

  async observe(instruction: string): Promise<Result<ObservedAction[], Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));

    log.debug({ instruction }, "browser observe");

    return tryCatch(async () => {
      const actions = await this.stagehand!.observe(instruction);
      return actions.map((a) => ({
        selector: a.selector,
        description: a.description,
        method: a.method,
        args: a.arguments,
      }));
    });
  }

  currentUrl(): string {
    if (!this.stagehand) return "";
    return this.stagehand.context.pages()[0].url();
  }

  async close(): Promise<void> {
    if (!this.stagehand) return;

    log.info("closing browser");
    await this.stagehand.close();
    this.stagehand = null;
  }

  isLaunched(): boolean {
    return this.stagehand !== null;
  }
}

export function toAgentTools(): ToolDefinition[] {
  return [
    {
      name: "browser_navigate",
      description: "Navigate the browser to a URL and return page info.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to navigate to." },
        },
        required: ["url"],
      },
    },
    {
      name: "browser_act",
      description: "Perform a browser action described in natural language.",
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "What action to perform." },
        },
        required: ["instruction"],
      },
    },
    {
      name: "browser_extract",
      description: "Extract structured data from the current page using a natural language instruction.",
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "What data to extract." },
        },
        required: ["instruction"],
      },
    },
    {
      name: "browser_extract_text",
      description: "Extract all visible text from the current page.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "browser_observe",
      description: "Observe available actions on the current page.",
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "What to look for on the page." },
        },
        required: ["instruction"],
      },
    },
  ];
}
