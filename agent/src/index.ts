import { randomUUID } from "node:crypto";
import { Subscription } from "rxjs";
import { Browser } from "./browser/stagehand.js";
import { ApiClient } from "./memory/api-client.js";
import { normalizeUrl } from "./memory/data-store.js";
import type { DataStore, SitemapEntry, SitemapStats } from "./memory/data-store.js";
import { A2AServer } from "./a2a/server.js";
import type { Message, SendMessageRequest } from "./a2a/types.js";
import {
  agentCard as coordinatorCard,
  createHandler as createCoordinatorHandler,
  parsePlan,
  buildFallbackPlan,
} from "./agents/coordinator.js";
import type { CoordinatorCommand, CoordinatorPlan } from "./agents/coordinator.js";
import {
  agentCard as navigatorCard,
  createHandler as createNavigatorHandler,
} from "./agents/navigator.js";
import {
  agentCard as testerCard,
  createHandler as createTesterHandler,
} from "./agents/tester.js";
import { createApp, startServer } from "./server/http.js";
import { logger, createLogger } from "./logger.js";

const log = createLogger("main");

// -- Config --

type AgentConfig = {
  targetUrl: string;
  maxPages: number;
  maxFindings: number;
  headless: boolean;
  apiUrl: string;
  sessionId: string;
};

function loadConfig(): AgentConfig {
  const targetUrl = process.env.TARGET_URL;
  if (!targetUrl) {
    logger.fatal("TARGET_URL environment variable is required");
    process.exit(1);
  }

  const apiUrl = process.env.KEA_API_URL;
  if (!apiUrl) {
    logger.fatal("KEA_API_URL environment variable is required");
    process.exit(1);
  }

  return {
    targetUrl,
    maxPages: Number(process.env.MAX_PAGES ?? "50"),
    maxFindings: Number(process.env.MAX_FINDINGS ?? "100"),
    headless: process.env.HEADLESS !== "false",
    apiUrl,
    sessionId: process.env.SESSION_ID ?? randomUUID(),
  };
}

// -- A2A message helpers --

function buildUserMessage(text: string): SendMessageRequest {
  const msg: Message = {
    messageId: randomUUID(),
    role: "ROLE_USER",
    parts: [{ text }],
  };
  return { message: msg };
}

// -- Exploration Loop --

type ExplorationLoop = {
  start(): Subscription;
  stop(): void;
  store: DataStore;
  agents: A2AServer[];
};

function createExplorationLoop(config: AgentConfig): ExplorationLoop {
  const store: DataStore = new ApiClient({
    baseUrl: config.apiUrl,
    sessionId: config.sessionId,
  });
  const browser = new Browser();

  // A2A servers available for external callers and internal use
  const coordinatorServer = new A2AServer(
    coordinatorCard,
    createCoordinatorHandler({ store }),
  );
  const navigatorServer = new A2AServer(
    navigatorCard,
    createNavigatorHandler({ store }),
  );
  const testerServer = new A2AServer(
    testerCard,
    createTesterHandler({ store }),
  );

  // Seed sitemap with target URL
  async function init(): Promise<void> {
    const client = store as ApiClient;
    await client.registerSession({
      id: config.sessionId,
      targetUrl: config.targetUrl,
      status: "running",
      maxPages: config.maxPages,
      config: {},
      startedAt: Date.now(),
    });
    await store.upsertPage({
      url: config.targetUrl,
      title: "",
      links: [],
      status: "discovered",
    });
  }

  const targetOrigin = new URL(config.targetUrl).origin;

  let pagesProcessed = 0;
  let abortController: AbortController | null = null;

  // -- Command executors --

  async function executeNavigate(url: string): Promise<void> {
    const normalizedUrl = normalizeUrl(url);
    log.info({ url: normalizedUrl, pagesProcessed }, "navigating page");

    const navResult = await browser.navigate(normalizedUrl);
    if (!navResult.ok) {
      log.error({ url: normalizedUrl, error: String(navResult.error.message) }, "navigation failed");
      await store.upsertPage({ url: normalizedUrl, title: "", links: [], status: "visited", visitedAt: Date.now() });
      return;
    }

    const resolvedUrl = normalizeUrl(navResult.value.url);

    // Detect SPA/server redirect: requested URL loaded a different page
    if (resolvedUrl !== normalizedUrl) {
      log.info({ from: normalizedUrl, to: resolvedUrl }, "page redirected — removing original");
      await store.removePage(normalizedUrl);
      // Don't count toward pagesProcessed; the target page will be crawled separately
      return;
    }

    // Detect 404 / not-found error pages
    const is404 = /\b404\b|not\s*found/i.test(navResult.value.title);
    if (is404) {
      log.warn({ url: resolvedUrl, title: navResult.value.title }, "404 page detected — removing from sitemap");
      await store.removePage(resolvedUrl);
      pagesProcessed++;
      return;
    }

    // Extract links from DOM (no LLM needed)
    const linksResult = await browser.extractLinks();
    const domLinks = (linksResult.ok ? linksResult.value : [])
      .map((href) => normalizeUrl(href))
      .filter((href) => {
        try { return new URL(href).origin === targetOrigin; }
        catch { return false; }
      });
    const uniqueLinks = [...new Set(domLinks)];

    // Store page as visited (never downgrades from tested)
    await store.visitPage(resolvedUrl, navResult.value.title, uniqueLinks);

    // Discover child links (insert-or-ignore — never downgrades)
    for (const link of uniqueLinks) {
      await store.discoverPage(link);
    }

    pagesProcessed++;
    log.info({ url: resolvedUrl, linksFound: uniqueLinks.length, pagesProcessed }, "page navigated");

    // Save navigator message to the store
    await store.addMessage({
      agentId: "navigator",
      content: `Explored ${resolvedUrl} — "${navResult.value.title}". Found ${uniqueLinks.length} links.`,
      thinking: `Navigating to ${normalizedUrl} to extract links and content.`,
      timestamp: Date.now(),
    });
  }

  async function executeTest(url: string): Promise<void> {
    log.info({ url }, "testing page");

    // Navigate to the page first so we can extract fresh content
    const navResult = await browser.navigate(url);
    if (!navResult.ok) {
      log.warn({ url, error: String(navResult.error.message) }, "test navigation failed, using stored data");
    }

    const textResult = await browser.extractText();
    if (!textResult.ok) {
      log.error({ url, error: String(textResult.error.message) }, "text extraction failed");
      return;
    }

    const title = navResult.ok ? navResult.value.title : "";
    const pageContent = `URL: ${url}\nTitle: ${title}\n\n${textResult.value}`;
    const testResult = await testerServer.sendMessage(
      buildUserMessage(pageContent),
    );
    if (!testResult.ok) {
      log.error({ error: String(testResult.error.message) }, "tester agent failed");
      return;
    }

    // Mark page as tested
    const pageResult = await store.getPage(url);
    const page = pageResult.ok ? pageResult.value : null;
    await store.upsertPage({
      url,
      title: page?.title ?? title,
      links: page?.links ?? [],
      status: "tested",
      visitedAt: Date.now(),
    });

    log.info({ url }, "page tested");
  }

  async function executeInvalidate(url: string): Promise<void> {
    log.info({ url }, "invalidating page — marking for re-crawl");
    await store.invalidatePage(url);
  }

  async function executeRemove(url: string): Promise<void> {
    log.info({ url }, "removing page from sitemap");
    await store.removePage(url);
  }

  // -- Coordinator consultation --

  function extractResponseText(task: { history?: Message[] }): string {
    const lastAgent = task.history
      ?.filter((m) => m.role === "ROLE_AGENT")
      .at(-1);
    return lastAgent?.parts.map((p) => p.text ?? "").join("\n") ?? "";
  }

  async function getPlan(): Promise<CoordinatorPlan> {
    const statsResult = await store.getSitemapStats();
    const stats: SitemapStats = statsResult.ok
      ? statsResult.value
      : { total: 0, discovered: 0, visited: 0, tested: 0 };

    const unvisited = await store.getUnvisitedPages(10);
    const untested = await store.getUntestedPages(10);
    const unvisitedPages = unvisited.ok ? unvisited.value : [];
    const untestedPages = untested.ok ? untested.value : [];

    // Ask the coordinator LLM
    const coordResult = await coordinatorServer.sendMessage(
      buildUserMessage(
        `Plan the next batch of work.\nStats: ${JSON.stringify(stats)}\n`
        + `Unvisited: ${JSON.stringify(unvisitedPages.map((p) => p.url))}\n`
        + `Untested: ${JSON.stringify(untestedPages.map((p) => p.url))}`,
      ),
    );

    if (!coordResult.ok) {
      log.warn({ error: String(coordResult.error.message) }, "coordinator failed, using fallback plan");
      return buildFallbackPlan(stats, unvisitedPages, untestedPages);
    }

    const responseText = extractResponseText(coordResult.value.task ?? {});
    const plan = parsePlan(responseText);

    // If the LLM returned only a "done" but there's actually work left, override
    if (plan.commands.length === 1 && plan.commands[0].type === "done"
      && (unvisitedPages.length > 0 || untestedPages.length > 0)) {
      log.warn("coordinator said done but work remains — using fallback plan");
      return buildFallbackPlan(stats, unvisitedPages, untestedPages);
    }

    log.info({ commandCount: plan.commands.length, commands: plan.commands }, "coordinator plan");
    return plan;
  }

  // -- Main loop --

  async function runLoop(signal: AbortSignal): Promise<void> {
    await init();

    const launchResult = await browser.launch({ headless: config.headless });
    if (!launchResult.ok) {
      log.error({ error: String(launchResult.error.message) }, "browser launch failed");
      return;
    }

    while (!signal.aborted) {
      if (pagesProcessed >= config.maxPages) {
        log.info({ pagesProcessed, maxPages: config.maxPages }, "max pages reached");
        break;
      }

      // Get a batch plan from the coordinator
      const plan = await getPlan();

      // Separate commands by type
      const navigates = plan.commands.filter((c): c is Extract<CoordinatorCommand, { type: "navigate" }> => c.type === "navigate");
      const tests = plan.commands.filter((c): c is Extract<CoordinatorCommand, { type: "test" }> => c.type === "test");
      const invalidates = plan.commands.filter((c): c is Extract<CoordinatorCommand, { type: "invalidate" }> => c.type === "invalidate");
      const removes = plan.commands.filter((c): c is Extract<CoordinatorCommand, { type: "remove" }> => c.type === "remove");
      const done = plan.commands.find((c) => c.type === "done");

      if (done) {
        log.info({ reason: done.type === "done" ? done.reason : "" }, "coordinator signalled done");
        break;
      }

      // Execute invalidations and removes immediately (synchronous, no I/O)
      for (const cmd of invalidates) await executeInvalidate(cmd.url);
      for (const cmd of removes) await executeRemove(cmd.url);

      // Navigate sequentially (single browser instance)
      for (const cmd of navigates) {
        if (signal.aborted || pagesProcessed >= config.maxPages) break;
        await executeNavigate(cmd.url);
      }

      // Test concurrently (LLM calls, no browser contention)
      if (tests.length > 0) {
        // Run tests sequentially since they share the browser for content extraction
        for (const cmd of tests) {
          if (signal.aborted) break;
          await executeTest(cmd.url);
        }
      }
    }
  }

  function start(): Subscription {
    log.info(
      { targetUrl: config.targetUrl, maxPages: config.maxPages },
      "starting exploration loop",
    );

    abortController = new AbortController();

    const sub = new Subscription(() => {
      abortController?.abort();
    });

    runLoop(abortController.signal)
      .then(async () => {
        log.info({ pagesProcessed }, "exploration loop completed");
        const client = store as ApiClient;
        await client.completeSession("completed");
        cleanup();
      })
      .catch(async (err) => {
        log.error({ error: err }, "exploration loop error");
        const client = store as ApiClient;
        await client.completeSession("failed").catch(() => {});
        cleanup();
      });

    return sub;
  }

  function stop(): void {
    log.info("stopping exploration loop");
    abortController?.abort();
    cleanup();
  }

  function cleanup(): void {
    coordinatorServer.dispose();
    navigatorServer.dispose();
    testerServer.dispose();
    browser.close().catch((err) => log.warn({ err }, "browser close error"));
  }

  return { start, stop, store, agents: [coordinatorServer, navigatorServer, testerServer] };
}

// -- Main --

async function main(): Promise<void> {
  const config = loadConfig();

  log.info(
    {
      targetUrl: config.targetUrl,
      maxPages: config.maxPages,
      maxFindings: config.maxFindings,
      headless: config.headless,
      apiUrl: config.apiUrl,
      sessionId: config.sessionId,
    },
    "kea agent starting",
  );

  const loop = createExplorationLoop(config);

  // Start the HTTP API server
  const app = createApp({ store: loop.store, agents: loop.agents });
  const server = startServer(app);

  const sub = loop.start();

  const shutdown = () => {
    log.info("received shutdown signal");
    loop.stop();
    sub.unsubscribe();
    loop.store.close();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "unhandled error");
  process.exit(1);
});
