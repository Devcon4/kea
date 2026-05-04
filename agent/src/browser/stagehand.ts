import { Stagehand } from "@browserbasehq/stagehand";
import { z, type ZodTypeAny } from "zod";
import { Ok, Err, tryCatch } from "../result.js";
import type { Result } from "../result.js";
import type {
  ConsoleMessage as DiagConsoleMessage,
  LlmFailure,
  NetworkFailure,
  PageError,
  RunDiagnostics,
} from "@kea/shared";
import { createLogger } from "../logger.js";
import { loadLlmEnv } from "../pi/env.js";

const log = createLogger("browser");

/**
 * Caps applied to in-memory ring buffers. The agent runs unattended; without
 * bounds a chatty test target could OOM the container long before a
 * scenario finishes. Numbers are tuned for "enough to debug a typical
 * failure" — not a complete trace.
 */
const MAX_CONSOLE_MESSAGES = 200;
const MAX_PAGE_ERRORS = 50;
const MAX_NETWORK_FAILURES = 50;
const MAX_DOM_SNIPPET_BYTES = 50_000;
const MAX_LLM_FAILURES = 20;
const MAX_LLM_BODY_CHARS = 8_000;

/**
 * Browser-side instrumentation installed via Page.addScriptToEvaluateOnNewDocument.
 * Hooks window error events and fetch() so we can recover the failure context
 * when a scenario flips to fail/error. Kept side-effect-free against the
 * page (no DOM mutation, no console output) — a misbehaving wrapper would
 * mask the very bug we're trying to diagnose.
 */
const DIAG_INIT_SCRIPT = `
(() => {
  if (window.__keaDiag) return;
  const MAX = ${MAX_PAGE_ERRORS};
  const NMAX = ${MAX_NETWORK_FAILURES};
  const buf = (window.__keaDiag = { pageErrors: [], networkFailures: [] });
  const cap = (arr, max, item) => { arr.push(item); if (arr.length > max) arr.shift(); };
  window.addEventListener('error', (e) => {
    cap(buf.pageErrors, MAX, {
      message: String(e.message || e.error || ''),
      stack: (e.error && e.error.stack) ? String(e.error.stack) : null,
      timestamp: Date.now(),
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    cap(buf.pageErrors, MAX, {
      message: (r && r.message) ? String(r.message) : String(r),
      stack: (r && r.stack) ? String(r.stack) : null,
      timestamp: Date.now(),
    });
  });
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function(...args) {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || '';
      const method = (args[1] && args[1].method) || (req && req.method) || 'GET';
      try {
        const res = await origFetch.apply(this, args);
        if (!res.ok) {
          cap(buf.networkFailures, NMAX, {
            url: String(url), method: String(method),
            status: res.status, statusText: res.statusText,
            errorText: null, timestamp: Date.now(),
          });
        }
        return res;
      } catch (err) {
        cap(buf.networkFailures, NMAX, {
          url: String(url), method: String(method),
          status: null, statusText: null,
          errorText: (err && err.message) ? String(err.message) : String(err),
          timestamp: Date.now(),
        });
        throw err;
      }
    };
  }
})();
`;

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
  private consoleMessages: DiagConsoleMessage[] = [];
  private consoleListener: ((msg: { type(): string; text(): string }) => void) | null = null;
  /**
   * LLM-provider calls that returned non-2xx during the current run, captured
   * by a fetch interceptor installed in `launch()`. Reset between runs by
   * `resetDiagnostics()`. Bounded by MAX_LLM_FAILURES.
   */
  private llmFailures: LlmFailure[] = [];
  private llmFetchUninstall: (() => void) | null = null;

  async launch(config?: BrowserConfig): Promise<Result<void, Error>> {
    if (this.stagehand) return Err(new Error("browser already launched"));

    this.config = { ...this.config, ...config };
    const llm = loadLlmEnv();

    log.info({ headless: this.config.headless, model: llm.model }, "launching browser");

    return tryCatch(async () => {
      const stagehand = new Stagehand({
        env: "LOCAL",
        model: {
          modelName: `openai/${llm.model}`,
          apiKey: llm.apiKey,
          baseURL: llm.baseUrl,
        },
        localBrowserLaunchOptions: {
          headless: this.config.headless,
          executablePath: process.env.CHROME_PATH,
          args: ["--no-sandbox", "--disable-gpu"],
        },
        verbose: 0,
        selfHeal: true,
      });

      await stagehand.init();

      const page = stagehand.context.pages()[0];
      if (this.config.viewport) {
        await page.setViewportSize(this.config.viewport.width, this.config.viewport.height);
      }

      // Install error/network instrumentation that survives navigation. The
      // CDP `addScriptToEvaluateOnNewDocument` API is the only way to inject
      // a hook before the page's own scripts run — evaluate() after
      // navigation races with site code and misses early failures.
      await page.sendCDP("Page.addScriptToEvaluateOnNewDocument", {
        source: DIAG_INIT_SCRIPT,
      });

      // Subscribe to console events on the agent side so we capture messages
      // emitted before any evaluate() round-trip. The buffer is bounded; old
      // messages are dropped silently rather than surfaced as truncated.
      const consoleListener = (msg: { type(): string; text(): string }) => {
        const level = mapConsoleLevel(msg.type());
        const text = msg.text();
        this.consoleMessages.push({ level, text, timestamp: Date.now() });
        if (this.consoleMessages.length > MAX_CONSOLE_MESSAGES) {
          this.consoleMessages.shift();
        }
      };
      page.on("console", consoleListener as Parameters<typeof page.on>[1]);
      this.consoleListener = consoleListener;

      this.stagehand = stagehand;
      this.installLlmFetchHook();
    });
  }

  async navigate(url: string): Promise<Result<PageInfo, Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));

    const page = this.stagehand.context.pages()[0];

    return tryCatch(async () => {
      const response = await page.goto(url, { timeoutMs: this.config.timeout });
      await this.waitForSettled();
      const title = await page.title();
      const finalUrl = page.url();
      // Surface server failures up the stack so the tester records the navigate
      // step as a fail with explicit evidence, instead of marching forward and
      // asserting against a 404 body. A redirected 200 is still a pass.
      if (response && !response.ok()) {
        const status = response.status();
        const statusText = response.statusText();
        throw new Error(
          `navigate received HTTP ${status} ${statusText} for ${finalUrl || url}`,
        );
      }
      return { url: finalUrl, title };
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

  async pageTitle(): Promise<Result<string, Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));
    return tryCatch(async () => {
      const page = this.stagehand!.context.pages()[0];
      return await page.title();
    });
  }

  async extract<T>(instruction: string, schema: ZodTypeAny): Promise<Result<T, Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));

    log.debug({ instruction }, "browser extract");

    return tryCatch(async () => {
      return (await this.stagehand!.extract(instruction, schema)) as T;
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
    this.consoleListener = null;
    this.consoleMessages = [];
    this.llmFailures = [];
    if (this.llmFetchUninstall) {
      this.llmFetchUninstall();
      this.llmFetchUninstall = null;
    }
  }

  isLaunched(): boolean {
    return this.stagehand !== null;
  }

  /**
   * Reset the per-run diagnostic buffers. Called by the tester at the start of
   * every scenario so a passing run's chatter never bleeds into a later
   * failure's evidence.
   */
  async resetDiagnostics(): Promise<void> {
    this.consoleMessages = [];
    this.llmFailures = [];
    if (!this.stagehand) return;
    const page = this.stagehand.context.pages()[0];
    try {
      await page.evaluate(`(() => {
        if (window.__keaDiag) {
          window.__keaDiag.pageErrors.length = 0;
          window.__keaDiag.networkFailures.length = 0;
        }
      })()`);
    } catch (err) {
      // Reset is best-effort — a fresh page may not yet have the script
      // installed. The next navigation will pick it up.
      log.debug({ err: toMessage(err) }, "resetDiagnostics evaluate failed (non-fatal)");
    }
  }

  /**
   * Capture failure diagnostics: a viewport screenshot, the current URL/title,
   * a truncated DOM snippet, and the buffered console/error/network events.
   * The screenshot is returned as raw bytes; the caller decides where to put it
   * (typically uploaded as a `screenshot` artifact).
   */
  async captureDiagnostics(opts: {
    failingStepIndex: number | null;
    expected?: unknown;
    observed?: unknown;
  }): Promise<Result<{ diagnostics: RunDiagnostics; screenshot: Buffer | null }, Error>> {
    if (!this.stagehand) return Err(new Error("browser not launched"));
    const page = this.stagehand.context.pages()[0];

    return tryCatch(async () => {
      const pageUrl = (() => {
        try {
          return page.url();
        } catch {
          return "";
        }
      })();
      const pageTitle = await page.title().catch(() => "");

      // Read the in-page buffers and DOM in one round-trip so we minimise
      // state drift between fields. A second navigation between calls would
      // otherwise produce a screenshot from one page and console events from
      // another, masking the actual failure context.
      type InPageState = {
        pageErrors: PageError[];
        networkFailures: NetworkFailure[];
        domSnippet: string;
        domTruncated: boolean;
      };
      const state = (await page.evaluate(`(() => {
        const max = ${MAX_DOM_SNIPPET_BYTES};
        const html = (document.documentElement && document.documentElement.outerHTML) || '';
        const truncated = html.length > max;
        const pageErrors = (window.__keaDiag && window.__keaDiag.pageErrors) ? window.__keaDiag.pageErrors.slice() : [];
        const networkFailures = (window.__keaDiag && window.__keaDiag.networkFailures) ? window.__keaDiag.networkFailures.slice() : [];
        return { pageErrors, networkFailures, domSnippet: truncated ? html.slice(0, max) : html, domTruncated: truncated };
      })()`)) as InPageState;

      let screenshot: Buffer | null = null;
      try {
        screenshot = await page.screenshot({ type: "png", fullPage: false });
      } catch (err) {
        log.warn({ err: toMessage(err) }, "screenshot capture failed (non-fatal)");
      }

      const diagnostics: RunDiagnostics = {
        failingStepIndex: opts.failingStepIndex,
        pageUrl,
        pageTitle,
        domSnippet: state.domSnippet,
        domTruncated: state.domTruncated,
        consoleMessages: this.consoleMessages.slice(),
        pageErrors: state.pageErrors,
        networkFailures: state.networkFailures,
        llmFailures: this.llmFailures.slice(),
        expected: opts.expected,
        observed: opts.observed,
        capturedAt: Date.now(),
      };
      return { diagnostics, screenshot };
    });
  }

  /**
   * Install a `globalThis.fetch` interceptor that records LLM-provider
   * failures (non-2xx responses to `LLM_BASE_URL`) into the per-run buffer.
   *
   * Stagehand's act/extract path runs through Vercel AI SDK → the openai
   * provider → platform fetch. When the upstream returns 4xx/5xx the AI SDK
   * wraps it in a generic `LanguageModelError` and the original payload +
   * response are lost. This hook captures both before they're discarded.
   *
   * Idempotent: if installed already, returns the existing uninstaller. Only
   * traffic to the configured LLM origin is touched; everything else passes
   * straight to native fetch.
   */
  private installLlmFetchHook(): void {
    if (this.llmFetchUninstall) return;
    const llm = loadLlmEnv();
    const targetOrigin = (() => {
      try {
        const u = new URL(llm.baseUrl);
        return `${u.protocol}//${u.host}`;
      } catch {
        return null;
      }
    })();
    if (!targetOrigin) {
      log.warn({ baseUrl: llm.baseUrl }, "LLM_BASE_URL not parseable; trace disabled");
      return;
    }
    const native = globalThis.fetch.bind(globalThis);
    const wrapped: typeof fetch = async (input, init) => {
      const urlString =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const reqOrigin = (() => {
        try {
          const u = new URL(urlString);
          return `${u.protocol}//${u.host}`;
        } catch {
          return null;
        }
      })();
      if (reqOrigin !== targetOrigin) return native(input, init);

      const method =
        init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
      const reqBodyText = readRequestBodyText(init?.body);
      const startedAt = Date.now();
      const response = await native(input, init);
      if (response.ok) return response;

      // We must not consume the original body — clone gives us an
      // independent stream. Best-effort; failures fall back to a marker.
      let respBodyText = "";
      try {
        respBodyText = await response.clone().text();
      } catch (err) {
        respBodyText = `<read body failed: ${toMessage(err)}>`;
      }
      this.recordLlmFailure({
        url: urlString,
        method,
        status: response.status,
        requestBody: reqBodyText.body,
        requestBodyTruncated: reqBodyText.truncated,
        responseBody: truncate(respBodyText).body,
        responseBodyTruncated: truncate(respBodyText).truncated,
        elapsedMs: Date.now() - startedAt,
        timestamp: Date.now(),
      });
      return response;
    };
    globalThis.fetch = wrapped;
    this.llmFetchUninstall = () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = native;
    };
    log.debug({ targetOrigin }, "llm fetch hook installed");
  }

  private recordLlmFailure(entry: LlmFailure): void {
    this.llmFailures.push(entry);
    if (this.llmFailures.length > MAX_LLM_FAILURES) this.llmFailures.shift();
    log.warn(
      {
        url: entry.url,
        status: entry.status,
        elapsedMs: entry.elapsedMs,
        requestBodyChars: entry.requestBody.length,
        responseBodyChars: entry.responseBody.length,
      },
      "llm provider returned non-2xx",
    );
  }
}

function mapConsoleLevel(type: string): DiagConsoleMessage["level"] {
  if (type === "error" || type === "warning" || type === "warn" || type === "info" || type === "debug") {
    return type === "warning" ? "warn" : (type as DiagConsoleMessage["level"]);
  }
  return "log";
}

function truncate(s: string): { body: string; truncated: boolean } {
  if (s.length <= MAX_LLM_BODY_CHARS) return { body: s, truncated: false };
  return { body: s.slice(0, MAX_LLM_BODY_CHARS), truncated: true };
}

/**
 * Best-effort extraction of a textual fetch request body. Streams and
 * non-text payloads are recorded as a sentinel so the diagnostic still says
 * something useful without buffering arbitrary bytes.
 */
function readRequestBodyText(body: unknown): {
  body: string;
  truncated: boolean;
} {
  if (body == null) return { body: "", truncated: false };
  if (typeof body === "string") return truncate(body);
  if (body instanceof URLSearchParams) return truncate(body.toString());
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    try {
      const buf = body instanceof ArrayBuffer ? body : (body as ArrayBufferView).buffer;
      return truncate(Buffer.from(buf as ArrayBuffer).toString("utf8"));
    } catch {
      return { body: "<binary body>", truncated: false };
    }
  }
  return { body: "<stream or non-text body>", truncated: false };
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}