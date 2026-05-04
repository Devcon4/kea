import { randomUUID } from "node:crypto";
import { SessionConfigSchema } from "@kea/shared";
import { Browser } from "./browser/stagehand.js";
import { discoverFromSitemap } from "./browser/http-discover.js";
import { runCoordinator } from "./agents/coordinator.js";
import { createLogger, logger } from "./logger.js";
import { ApiClient } from "./memory/api-client.js";


const log = createLogger("main");

type AgentConfig = {
  targetUrl: string;
  maxPages: number;
  headless: boolean;
  apiUrl: string;
  sessionId: string;
  sessionConfig: Record<string, unknown>;
};

function loadSessionConfigFromEnv(): Record<string, unknown> {
  const raw = process.env.SESSION_CONFIG_JSON;
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logger.fatal("SESSION_CONFIG_JSON must be a JSON object");
    process.exit(1);
  } catch (error) {
    logger.fatal(
      { error: error instanceof Error ? error.message : String(error) },
      "invalid SESSION_CONFIG_JSON",
    );
    process.exit(1);
  }
}

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
    headless: process.env.HEADLESS !== "false",
    apiUrl,
    sessionId: process.env.SESSION_ID ?? randomUUID(),
    sessionConfig: loadSessionConfigFromEnv(),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  log.info(
    {
      targetUrl: config.targetUrl,
      maxPages: config.maxPages,
      headless: config.headless,
      apiUrl: config.apiUrl,
      sessionId: config.sessionId,
    },
    "kea agent starting",
  );

  const store = new ApiClient({ baseUrl: config.apiUrl, sessionId: config.sessionId });
  const browser = new Browser();
  const targetOrigin = new URL(config.targetUrl).origin;

  const abortController = new AbortController();
  const shutdown = (signal: string) => {
    log.info({ signal }, "received shutdown signal");
    abortController.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    const registered = await store.registerSession({
      id: config.sessionId,
      targetUrl: config.targetUrl,
      status: "running",
      maxPages: config.maxPages,
      config: config.sessionConfig,
      startedAt: Date.now(),
    });
    if (!registered.ok) throw registered.error;

    const rootPage = await store.upsertPage({
      url: config.targetUrl,
      title: "",
      links: [],
      status: "discovered",
    });
    if (!rootPage.ok) throw rootPage.error;

    // Seed the sitemap from /sitemap.xml + robots.txt before the LLM ever
    // runs. Static enumeration is deterministic, free, and the only path
    // that recovers URLs from SPA shells whose entry HTML has no anchors.
    const advertised = await discoverFromSitemap(targetOrigin);
    if (advertised.length > 0) {
      log.info({ targetOrigin, count: advertised.length }, "sitemap.xml seeded URLs");
      for (const url of advertised) {
        await store.discoverPage(url);
      }
    } else {
      log.info({ targetOrigin }, "no sitemap.xml or robots.txt sitemap directives found");
    }

    const persistedSession = await store.getSession();
    if (!persistedSession.ok) throw persistedSession.error;
    if (!persistedSession.value) {
      throw new Error(`session ${config.sessionId} not found after registration`);
    }

    const parsedSessionConfig = SessionConfigSchema.safeParse(persistedSession.value.config ?? {});
    if (!parsedSessionConfig.success) {
      log.fatal(
        { issues: parsedSessionConfig.error.issues },
        "persisted session config is invalid",
      );
      process.exit(1);
    }

    for (const seed of parsedSessionConfig.data.seedFeatures) {
      const created = await store.createFeature({
        name: seed.name,
        description: seed.description,
        urlPatterns: seed.urlPatterns,
        status: seed.status,
        discoveredBy: "manual",
        initialPlan: seed.initialPlan,
      });
      if (!created.ok) {
        log.fatal(
          {
            featureName: seed.name,
            error: created.error.message,
          },
          "invalid seed feature; aborting session startup",
        );
        process.exit(1);
      }
    }

    const launchResult = await browser.launch({ headless: config.headless });
    if (!launchResult.ok) {
      log.error({ error: launchResult.error.message }, "browser launch failed");
      await store.completeSession("failed").catch(() => {});
      process.exit(1);
    }

    const sessionStartedAt = Date.now();
    const outcome = await runCoordinator(
      {
        store,
        browser,
        targetOrigin,
        maxPages: config.maxPages,
        sessionId: config.sessionId,
        sessionStartedAt,
        maxScenariosPerRun: parsedSessionConfig.data.maxScenariosPerRun,
      },
      abortController.signal,
    );

    await store.completeSession(outcome.status);
    if (outcome.status === "failed") {
      log.error({ reason: outcome.reason }, "session ended in failed state");
    } else {
      log.info({ reason: outcome.reason }, "exploration complete");
    }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "exploration failed");
    await store.completeSession("failed").catch(() => {});
    process.exit(1);
  } finally {
    await browser.close().catch((err) => log.warn({ err }, "browser close error"));
    store.close();
  }
}

main().catch((err) => {
  logger.fatal({ err }, "unhandled error");
  process.exit(1);
});
