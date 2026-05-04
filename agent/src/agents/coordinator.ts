import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Browser } from "../browser/stagehand.js";
import { discoverPageLinks } from "../browser/http-discover.js";
import { createLogger } from "../logger.js";
import { normalizeUrl } from "../memory/data-store.js";
import type {
  DataStore,
  FeatureWithActivePlan,
  Scenario,
  SitemapEntry,
  SitemapStats,
} from "../memory/data-store.js";
import { bridgeSessionToStore } from "../pi/bridge.js";
import { createKeaSession } from "../pi/session.js";
import type { KeaAgentSession } from "../pi/session.js";
import { runPlannerAuthor, runPlannerDiscover } from "./planner.js";
import { runTester, defaultPlanFlawJudge } from "./tester.js";

const log = createLogger("coordinator");

type UrlPatternLike = {
  test(input: string): boolean;
};

declare const URLPattern: {
  new (input: string): UrlPatternLike;
};

export const COORDINATOR_SYSTEM_PROMPT = `You orchestrate a feature-driven crawl. Each turn you see the sitemap, the discovery backlog, the plan-authoring backlog, the unrun-scenarios queue, and the stale-features queue.

Make exactly ONE tool call per turn.
Coverage first: navigate before discovering features; discover features before authoring plans; author plans before running scenarios.
Never call done while any of the five work queues are non-empty.
Do NOT emit JSON, prose plans, or markdown — only tool calls.

ID rules:
- Use the EXACT numeric ids that appear in the rendered state (e.g. "#42 Login" → featureId 42). Do NOT invent ids.
- If a tool response lists valid ids in its hint text, your next call MUST use one of those ids.
- If you are uncertain which feature to author, pick the first id from the planless list verbatim.

Tools:
- navigate(url): Visit a discovered URL, extract links, and update sitemap state.
- discover_features(url): Discover feature capabilities from a visited URL.
- author_plan(featureId): Author or revise the active scenario plan for a feature.
- test(scenarioId): Execute one scenario and persist its run/finding records.
- revalidate_feature(featureId): Re-check a stale feature and either re-author plans or retire it.
- invalidate(url): Mark a page stale so it is re-crawled.
- remove(url): Remove a page from sitemap tracking.
- done(reason): Signal completion when queues are empty.
- fail_session(reason): Last-resort abort. Refused while pending work remains and stagnation has not maxed out — do not call it as an early escape.`;

export type CoordinatorDeps = {
  store: DataStore;
  browser: Browser;
  targetOrigin: string;
  maxPages: number;
  sessionId: string;
  sessionStartedAt: number;
  maxScenariosPerRun?: number;
};

export type CoordinatorAction =
  | { type: "navigate"; url: string }
  | { type: "discover_features"; url: string }
  | { type: "author_plan"; featureId: number }
  | { type: "test"; scenarioId: number }
  | { type: "revalidate_feature"; featureId: number }
  | { type: "invalidate"; url: string }
  | { type: "remove"; url: string }
  | { type: "done"; reason: string }
  | { type: "fail_session"; reason: string };

export function buildFallbackPlan(
  _stats: SitemapStats,
  unvisited: SitemapEntry[],
  discoverlessUrls: string[],
  planlessFeatures: FeatureWithActivePlan[],
  unrunScenarios: Scenario[],
  staleFeatures: FeatureWithActivePlan[],
): CoordinatorAction {
  if (unvisited.length > 0) return { type: "navigate", url: unvisited[0].url };
  if (discoverlessUrls.length > 0) {
    return { type: "discover_features", url: discoverlessUrls[0] };
  }
  if (planlessFeatures.length > 0) {
    return { type: "author_plan", featureId: planlessFeatures[0].feature.id };
  }
  if (unrunScenarios.length > 0) {
    return { type: "test", scenarioId: unrunScenarios[0].id };
  }
  if (staleFeatures.length > 0) {
    return { type: "revalidate_feature", featureId: staleFeatures[0].feature.id };
  }
  return { type: "done", reason: "all features verified, all scenarios run" };
}

type ProgressCounter = {
  pagesProcessed: number;
  scenariosRun: number;
  featuresDiscoveryRuns: number;
  signalledDone: boolean;
  doneReason: string;
  outcome: "completed" | "failed" | null;
  stagnantStreak: number;
  lastProgressSignature: string;
};

type CoordinatorState = {
  stats: SitemapStats;
  unvisited: SitemapEntry[];
  discoverlessUrls: string[];
  planlessFeatures: FeatureWithActivePlan[];
  unrunScenarios: Scenario[];
  staleFeatures: FeatureWithActivePlan[];
};

export function buildCoordinatorTools(
  deps: CoordinatorDeps,
  progress: ProgressCounter,
): ToolDefinition[] {
  const navigateTool = defineTool({
    name: "navigate",
    label: "Navigate",
    description: "Visit a discovered URL, extract links, and add same-origin pages to the sitemap.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL of a page on the unvisited list." }),
    }),
    execute: async (_id, { url }) => {
      const summary = await executeNavigate(deps, url);
      progress.pagesProcessed += 1;
      return { content: [{ type: "text", text: summary }], details: { url } };
    },
  });

  const discoverFeaturesTool = defineTool({
    name: "discover_features",
    label: "Discover features",
    description: "Discover feature capabilities represented by a URL.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL whose capability set should be discovered." }),
    }),
    execute: async (_id, { url }) => {
      const summary = await executeDiscoverFeatures(deps, progress, url);
      return { content: [{ type: "text", text: summary }], details: { url } };
    },
  });

  const authorPlanTool = defineTool({
    name: "author_plan",
    label: "Author feature plan",
    description: "Author test scenarios for a feature that has no active plan.",
    parameters: Type.Object({
      featureId: Type.Number({ description: "Feature id awaiting plan authoring." }),
    }),
    execute: async (_id, { featureId }) => {
      const summary = await executeAuthorPlan(deps, featureId);
      return { content: [{ type: "text", text: summary }], details: { featureId } };
    },
  });

  const testTool = defineTool({
    name: "test",
    label: "Run scenario",
    description: "Run one unrun scenario from this session.",
    parameters: Type.Object({
      scenarioId: Type.Number({ description: "Scenario id to execute." }),
    }),
    execute: async (_id, { scenarioId }) => {
      const summary = await executeScenarioTest(deps, progress, scenarioId);
      return { content: [{ type: "text", text: summary }], details: { scenarioId } };
    },
  });

  const revalidateFeatureTool = defineTool({
    name: "revalidate_feature",
    label: "Revalidate feature",
    description: "Re-check a stale feature and refresh or retire it.",
    parameters: Type.Object({
      featureId: Type.Number({ description: "Stale feature id to revalidate." }),
    }),
    execute: async (_id, { featureId }) => {
      const summary = await executeRevalidateFeature(deps, progress, featureId);
      return { content: [{ type: "text", text: summary }], details: { featureId } };
    },
  });

  const invalidateTool = defineTool({
    name: "invalidate",
    label: "Invalidate",
    description: "Mark a page as discovered again so it can be revisited.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to invalidate." }),
    }),
    execute: async (_id, { url }) => {
      const result = await deps.store.invalidatePage(url);
      const text = result.ok
        ? `invalidated ${url}`
        : `failed to invalidate ${url}: ${result.error.message}`;
      return { content: [{ type: "text", text }], details: { url } };
    },
  });

  const removeTool = defineTool({
    name: "remove",
    label: "Remove",
    description: "Remove a page from the sitemap.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to remove." }),
    }),
    execute: async (_id, { url }) => {
      const result = await deps.store.removePage(url);
      const text = result.ok
        ? `removed ${url}`
        : `failed to remove ${url}: ${result.error.message}`;
      return { content: [{ type: "text", text }], details: { url } };
    },
  });

  const doneTool = defineTool({
    name: "done",
    label: "Done",
    description: "Signal completion when all work queues are empty.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the run can end." }),
    }),
    execute: async (_id, { reason }) => {
      // Use the RAW state (no scenario-cap mask) for the done gate. The cap is
      // a per-run budget that limits how many scenarios this process will
      // launch — it is not evidence that the session has nothing left to do.
      // Masking unrun scenarios here lets the coordinator declare "done" while
      // the queue still has work, which corrupts the session record.
      const state = await collectCoordinatorState(deps);
      const capReached = isScenarioCapReached(deps, progress);
      if (hasPendingWork(state)) {
        const capNote = capReached
          ? ` (scenario-rerun cap reached: ${progress.scenariosRun}/${deps.maxScenariosPerRun ?? "∞"} — use fail_session if no further test() calls are possible)`
          : "";
        const text =
          `cannot mark done: unvisited=${state.stats.discovered}, ` +
          `discoveryBacklog=${state.discoverlessUrls.length}, ` +
          `planless=${state.planlessFeatures.length}, ` +
          `unrunScenarios=${state.unrunScenarios.length}, ` +
          `staleFeatures=${state.staleFeatures.length}${capNote}`;
        return {
          content: [{ type: "text", text }],
          details: { reason, overridden: true, capReached },
        };
      }

      progress.signalledDone = true;
      progress.doneReason = reason;
      progress.outcome = "completed";
      return {
        content: [{ type: "text", text: `done: ${reason}` }],
        details: { reason, overridden: false, capReached: false },
        terminate: true,
      };
    },
  });

  const failSessionTool = defineTool({
    name: "fail_session",
    label: "Fail session",
    description:
      "Last-resort abort. Marks this session as failed and stops the run. Only call when no tool can resolve the current state and no real progress has been made for many turns.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the session must be failed." }),
    }),
    execute: async (_id, { reason }) => {
      const state = applyScenarioCap(await collectCoordinatorState(deps), deps, progress);
      if (hasPendingWork(state) && progress.stagnantStreak < STAGNATION_LIMIT) {
        const text =
          `cannot fail yet: pending work remains (planless=${state.planlessFeatures.length}, ` +
          `unrunScenarios=${state.unrunScenarios.length}, unvisited=${state.stats.discovered}). ` +
          `Use author_plan/test/navigate against the listed IDs/URLs. ` +
          `Stagnation streak ${progress.stagnantStreak}/${STAGNATION_LIMIT} — fail_session unlocks at the limit.`;
        log.warn(
          { reason, streak: progress.stagnantStreak },
          "fail_session refused; pending work remains",
        );
        return {
          content: [{ type: "text", text }],
          details: { reason, refused: true, stagnantStreak: progress.stagnantStreak },
        };
      }
      progress.signalledDone = true;
      progress.doneReason = reason;
      progress.outcome = "failed";
      log.warn({ reason }, "coordinator fail_session invoked");
      return {
        content: [{ type: "text", text: `failed: ${reason}` }],
        details: { reason, refused: false, stagnantStreak: progress.stagnantStreak },
        terminate: true,
      };
    },
  });

  return [
    navigateTool,
    discoverFeaturesTool,
    authorPlanTool,
    testTool,
    revalidateFeatureTool,
    invalidateTool,
    removeTool,
    doneTool,
    failSessionTool,
  ];
}

async function executeNavigate(deps: CoordinatorDeps, rawUrl: string): Promise<string> {
  const url = normalizeUrl(rawUrl);
  log.info({ url }, "navigate tool invoked");

  const navResult = await deps.browser.navigate(url);
  if (!navResult.ok) {
    await deps.store.upsertPage({
      url,
      title: "",
      links: [],
      status: "visited",
      visitedAt: Date.now(),
    });
    return `navigation failed for ${url}: ${navResult.error.message}`;
  }

  const resolvedUrl = normalizeUrl(navResult.value.url);
  if (resolvedUrl !== url) {
    log.info({ from: url, to: resolvedUrl }, "page redirected — removing original");
    await deps.store.removePage(url);
    return `redirected ${url} → ${resolvedUrl}; original removed`;
  }

  const is404 = /\b404\b|not\s*found/i.test(navResult.value.title);
  if (is404) {
    await deps.store.removePage(resolvedUrl);
    return `404 detected at ${resolvedUrl}; removed from sitemap`;
  }

  const { fetched, urls } = await discoverPageLinks(resolvedUrl);
  if (!fetched) {
    log.warn({ url: resolvedUrl }, "static link discovery: HTTP fetch failed");
  } else if (!fetched.contentType?.toLowerCase().includes("html")) {
    log.info(
      { url: resolvedUrl, contentType: fetched.contentType, status: fetched.status },
      "static link discovery: non-HTML response, no links extracted",
    );
  }
  const sameOriginLinks = urls
    .filter((u) => sameOrigin(u.url, deps.targetOrigin))
    .map((u) => normalizeUrl(u.url));
  const uniqueLinks = [...new Set(sameOriginLinks)];
  const sourceCounts = urls.reduce<Record<string, number>>((acc, u) => {
    acc[u.source] = (acc[u.source] ?? 0) + 1;
    return acc;
  }, {});
  log.info(
    {
      url: resolvedUrl,
      raw: urls.length,
      sameOrigin: uniqueLinks.length,
      bySource: sourceCounts,
    },
    "static link discovery summary",
  );

  await deps.store.visitPage(resolvedUrl, navResult.value.title, uniqueLinks);
  for (const link of uniqueLinks) {
    await deps.store.discoverPage(link);
  }

  return `visited ${resolvedUrl} — "${navResult.value.title}"; discovered ${uniqueLinks.length} same-origin links`;
}

async function executeDiscoverFeatures(
  deps: CoordinatorDeps,
  progress: ProgressCounter,
  rawUrl: string,
): Promise<string> {
  const url = normalizeUrl(rawUrl);
  progress.featuresDiscoveryRuns += 1;
  const discovered = await runPlannerDiscover({
    url,
    browser: deps.browser,
    store: deps.store,
    sessionId: deps.sessionId,
  });
  return `discovered ${discovered.featuresAdded} features (${discovered.featuresLinked} relinked) at ${url}`;
}

async function executeAuthorPlan(deps: CoordinatorDeps, featureId: number): Promise<string> {
  const loaded = await deps.store.getFeature(featureId);
  if (!loaded.ok) {
    return `failed to load feature #${featureId}: ${loaded.error.message}; ${await renderPlanlessHint(deps)}`;
  }
  if (!loaded.value) {
    return `feature #${featureId} not found. ${await renderPlanlessHint(deps)}`;
  }

  if (loaded.value.activePlan) {
    return `feature #${featureId} already has an active plan; skipped. ${await renderPlanlessHint(deps)}`;
  }

  const authored = await runPlannerAuthor({ featureId, browser: deps.browser, store: deps.store });
  const revision = authored.planRevision === null ? "none" : String(authored.planRevision);
  return `authored ${authored.scenariosAdded} scenarios under plan revision ${revision} for feature #${featureId}`;
}

async function renderPlanlessHint(deps: CoordinatorDeps): Promise<string> {
  const list = await deps.store.listFeatures({ status: "active" });
  if (!list.ok) return "";
  const planless = list.value.filter((f) => f.activePlan === null);
  if (planless.length === 0) return "No features currently need plan authoring.";
  const summary = planless
    .slice(0, 10)
    .map(({ feature }) => `#${feature.id} ${feature.name}`)
    .join(", ");
  return `Planless features awaiting author_plan: ${summary}.`;
}

async function executeScenarioTest(
  deps: CoordinatorDeps,
  progress: ProgressCounter,
  scenarioId: number,
): Promise<string> {
  if (isScenarioCapReached(deps, progress)) {
    return "scenario rerun cap reached; skipping";
  }

  const listed = await deps.store.listScenarios({
    runState: "unrun-this-session",
    since: deps.sessionStartedAt,
  });
  if (!listed.ok) {
    return `failed to list unrun scenarios: ${listed.error.message}; continuing`;
  }

  const scenario = listed.value.find((candidate) => candidate.id === scenarioId);
  if (!scenario) {
    const valid = listed.value
      .slice(0, 10)
      .map((s) => `#${s.id} ${s.name}`)
      .join(", ");
    const hint = valid.length
      ? `Unrun scenarios: ${valid}.`
      : "No unrun scenarios remain this session.";
    return `scenario #${scenarioId} not found in unrun queue. ${hint}`;
  }

  const run = await runTester({
      scenario,
      browser: deps.browser,
      store: deps.store,
      sessionId: deps.sessionId,
      flawJudge: defaultPlanFlawJudge,
    });
  progress.scenariosRun += 1;
  return `scenario #${scenarioId} ran: ${run.result} (runId=${run.runId ?? "none"}, findingId=${run.findingId ?? "none"})`;
}

async function executeRevalidateFeature(
  deps: CoordinatorDeps,
  progress: ProgressCounter,
  featureId: number,
): Promise<string> {
  const loaded = await deps.store.getFeature(featureId);
  if (!loaded.ok) {
    return `failed to load feature #${featureId}: ${loaded.error.message}`;
  }
  if (!loaded.value) {
    return `feature #${featureId} not found; skipped`;
  }

  if (loaded.value.feature.status === "retired") {
    return `feature #${featureId} is retired; refusing to revalidate (use a fresh discover_features run if the page changed)`;
  }

  if (loaded.value.feature.urlPatterns.length === 0) {
    log.warn({ featureId }, "stale feature has no url patterns; retiring");
    const retired = await deps.store.updateFeature(featureId, {
      status: "retired",
      verifiedAt: Date.now(),
    });
    if (!retired.ok) {
      return `feature #${featureId} had no URL patterns and could not be retired: ${retired.error.message}`;
    }
    return `feature #${featureId} has no URL patterns; retired`;
  }

  const probeUrl = resolveFeatureProbeUrl(loaded.value.feature.urlPatterns);
  if (!probeUrl) {
    const retired = await deps.store.updateFeature(featureId, {
      status: "retired",
      verifiedAt: Date.now(),
    });
    if (!retired.ok) {
      return `feature #${featureId} URL patterns are unverifiable and retire failed: ${retired.error.message}`;
    }
    return `feature #${featureId} URL patterns are unverifiable; retired`;
  }

  await executeNavigate(deps, probeUrl);
  const discovered = await runPlannerDiscover({
    url: probeUrl,
    browser: deps.browser,
    store: deps.store,
    sessionId: deps.sessionId,
  });
  progress.featuresDiscoveryRuns += 1;

  const refreshed = await deps.store.getFeature(featureId);
  if (!refreshed.ok) {
    return `revalidation failed to reload feature #${featureId}: ${refreshed.error.message}`;
  }
  if (!refreshed.value) {
    return `feature #${featureId} not found after revalidation; continuing`;
  }

  const stillApplies = refreshed.value.feature.urlPatterns.some((patternSource) => {
    try {
      return new URLPattern(patternSource).test(probeUrl);
    } catch {
      return false;
    }
  });

  if (!stillApplies) {
    const retired = await deps.store.updateFeature(featureId, {
      status: "retired",
      verifiedAt: Date.now(),
    });
    if (!retired.ok) {
      return `feature #${featureId} no longer applies and retire failed: ${retired.error.message}`;
    }
    return `feature #${featureId} no longer matches ${probeUrl}; retired`;
  }

  const reactivated = await deps.store.updateFeature(featureId, {
    status: "active",
    verifiedAt: Date.now(),
  });
  if (!reactivated.ok) {
    return `feature #${featureId} matched ${probeUrl} but could not be reactivated: ${reactivated.error.message}`;
  }

  const authored = await runPlannerAuthor({ featureId, browser: deps.browser, store: deps.store });
  const revision = authored.planRevision === null ? "none" : String(authored.planRevision);
  return (
    `feature #${featureId} revalidated at ${probeUrl}; ` +
    `discover re-run added ${discovered.featuresAdded} features (${discovered.featuresLinked} relinked); ` +
    `authored ${authored.scenariosAdded} scenarios under revision ${revision}`
  );
}

function resolveFeatureProbeUrl(urlPatterns: string[]): string | null {
  for (const pattern of urlPatterns) {
    try {
      return normalizeUrl(new URL(pattern).toString());
    } catch {
      const prefix = pattern.match(/^https?:\/\/[^*]+/i)?.[0];
      if (!prefix) continue;
      const candidate = prefix.endsWith("/") ? prefix : `${prefix}/`;
      try {
        return normalizeUrl(new URL(candidate).toString());
      } catch {
        continue;
      }
    }
  }

  return null;
}

function sameOrigin(href: string, targetOrigin: string): boolean {
  try {
    return new URL(href).origin === targetOrigin;
  } catch {
    return false;
  }
}

async function collectCoordinatorState(deps: CoordinatorDeps): Promise<CoordinatorState> {
  const [stats, unvisited, allPages, allFeatures, activeFeatures, unrunScenarios, staleFeatures] =
    await Promise.all([
      deps.store.getSitemapStats(),
      deps.store.getUnvisitedPages(10),
      deps.store.getAllPages(),
      deps.store.listFeatures(),
      deps.store.listFeatures({ status: "active" }),
      deps.store.listScenarios({ runState: "unrun-this-session", since: deps.sessionStartedAt }),
      deps.store.listFeatures({ status: "stale" }),
    ]);

  const statsValue = stats.ok ? stats.value : { total: 0, discovered: 0, visited: 0, tested: 0 };
  const unvisitedValue = unvisited.ok ? unvisited.value : [];
  const allPagesValue = allPages.ok ? allPages.value : [];
  const allFeaturesValue = allFeatures.ok ? allFeatures.value : [];
  const activeFeaturesValue = activeFeatures.ok ? activeFeatures.value : [];
  const unrunScenariosValue = unrunScenarios.ok ? unrunScenarios.value : [];
  const staleFeaturesValue = staleFeatures.ok ? staleFeatures.value : [];

  const visitedUrls = allPagesValue
    .filter((page) => page.status === "visited")
    .map((page) => page.url);
  const discoverlessUrls = computeDiscoverlessUrls(visitedUrls, allFeaturesValue);
  const planlessFeatures = activeFeaturesValue.filter((f) => f.activePlan === null);

  return {
    stats: statsValue,
    unvisited: unvisitedValue,
    discoverlessUrls,
    planlessFeatures,
    unrunScenarios: unrunScenariosValue,
    staleFeatures: staleFeaturesValue,
  };
}

function computeDiscoverlessUrls(urls: string[], features: FeatureWithActivePlan[]): string[] {
  const compiledPatterns: UrlPatternLike[] = [];
  for (const { feature } of features) {
    for (const patternSource of feature.urlPatterns) {
      try {
        compiledPatterns.push(new URLPattern(patternSource));
      } catch {
        log.warn(
          { featureId: feature.id, patternSource },
          "invalid URLPattern while computing discovery backlog",
        );
      }
    }
  }

  return urls.filter((url) => compiledPatterns.every((pattern) => !pattern.test(url)));
}

function renderState(state: CoordinatorState): string {
  const unvisitedUrls = state.unvisited.slice(0, 10).map((page) => page.url);
  const discoverless = state.discoverlessUrls.slice(0, 10);
  const planless = state.planlessFeatures.slice(0, 10).map(({ feature }) => {
    const entry =
      resolveFeatureProbeUrl(feature.urlPatterns) ?? feature.urlPatterns[0] ?? "(no url)";
    return `#${feature.id} ${feature.name} [patterns=${JSON.stringify(feature.urlPatterns)}] entry=${entry}`;
  });
  const unrunScenarios = state.unrunScenarios
    .slice(0, 10)
    .map((scenario) => `#${scenario.id} ${scenario.name}`);
  const stale = state.staleFeatures
    .slice(0, 10)
    .map(({ feature }) => `#${feature.id} ${feature.name}`);

  return [
    `Sitemap stats: ${JSON.stringify(state.stats)}`,
    `Unvisited URLs (${state.stats.discovered}): ${JSON.stringify(unvisitedUrls)}`,
    `URLs awaiting feature discovery (${state.discoverlessUrls.length}): ${JSON.stringify(discoverless)}`,
    `Features awaiting test plan (${state.planlessFeatures.length}): ${JSON.stringify(planless)}`,
    `Active scenarios to run (${state.unrunScenarios.length}): ${JSON.stringify(unrunScenarios)}`,
    `Stale features (${state.staleFeatures.length}): ${JSON.stringify(stale)}`,
    "",
    "Pick the next action.",
  ].join("\n");
}

const KNOWN_TOOL_NAMES = new Set([
  "navigate",
  "discover_features",
  "author_plan",
  "test",
  "revalidate_feature",
  "invalidate",
  "remove",
  "done",
  "fail_session",
]);

const STAGNATION_LIMIT = 8;
const STAGNATION_RESCUE = 3;

function countLastTurnToolCalls(kea: KeaAgentSession): {
  total: number;
  known: number;
  unknownNames: string[];
} {
  const last = kea.session.messages.at(-1);
  if (!last || (last as { role?: string }).role !== "assistant") {
    return { total: 0, known: 0, unknownNames: [] };
  }
  const content = (last as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return { total: 0, known: 0, unknownNames: [] };
  let total = 0;
  let known = 0;
  const unknownNames: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string };
    if (b.type !== "toolCall") continue;
    total += 1;
    if (typeof b.name === "string" && KNOWN_TOOL_NAMES.has(b.name)) {
      known += 1;
    } else if (typeof b.name === "string") {
      unknownNames.push(b.name);
    }
  }
  return { total, known, unknownNames };
}

function progressSignature(state: CoordinatorState, progress: ProgressCounter): string {
  return [
    progress.pagesProcessed,
    progress.scenariosRun,
    progress.featuresDiscoveryRuns,
    state.stats.discovered,
    state.stats.visited,
    state.stats.tested,
    state.unvisited.length,
    state.discoverlessUrls.length,
    state.planlessFeatures.length,
    state.unrunScenarios.length,
    state.staleFeatures.length,
  ].join(":");
}

function hasPendingWork(state: CoordinatorState): boolean {
  return (
    state.unvisited.length > 0 ||
    state.discoverlessUrls.length > 0 ||
    state.planlessFeatures.length > 0 ||
    state.unrunScenarios.length > 0 ||
    state.staleFeatures.length > 0
  );
}

function isScenarioCapReached(deps: CoordinatorDeps, progress: ProgressCounter): boolean {
  if (typeof deps.maxScenariosPerRun !== "number") return false;
  return progress.scenariosRun >= deps.maxScenariosPerRun;
}

function applyScenarioCap(
  state: CoordinatorState,
  deps: CoordinatorDeps,
  progress: ProgressCounter,
): CoordinatorState {
  if (!isScenarioCapReached(deps, progress)) return state;
  return { ...state, unrunScenarios: [] };
}

async function runFallbackAction(
  deps: CoordinatorDeps,
  progress: ProgressCounter,
  state: CoordinatorState,
): Promise<void> {
  const effectiveState = applyScenarioCap(state, deps, progress);
  const action = buildFallbackPlan(
    effectiveState.stats,
    effectiveState.unvisited,
    effectiveState.discoverlessUrls,
    effectiveState.planlessFeatures,
    effectiveState.unrunScenarios,
    effectiveState.staleFeatures,
  );

  log.info({ action }, "executing deterministic fallback");

  switch (action.type) {
    case "navigate":
      await executeNavigate(deps, action.url);
      progress.pagesProcessed += 1;
      break;
    case "discover_features":
      await executeDiscoverFeatures(deps, progress, action.url);
      break;
    case "author_plan":
      await executeAuthorPlan(deps, action.featureId);
      break;
    case "test":
      await executeScenarioTest(deps, progress, action.scenarioId);
      break;
    case "revalidate_feature":
      await executeRevalidateFeature(deps, progress, action.featureId);
      break;
    case "done":
      progress.signalledDone = true;
      progress.doneReason = action.reason;
      progress.outcome = "completed";
      break;
    case "fail_session":
      progress.signalledDone = true;
      progress.doneReason = action.reason;
      progress.outcome = "failed";
      break;
    default:
      break;
  }
}

export type CoordinatorOutcome = {
  status: "completed" | "failed";
  reason: string;
};

export async function runCoordinator(
  deps: CoordinatorDeps,
  signal: AbortSignal,
): Promise<CoordinatorOutcome> {
  const progress: ProgressCounter = {
    pagesProcessed: 0,
    scenariosRun: 0,
    featuresDiscoveryRuns: 0,
    signalledDone: false,
    doneReason: "",
    outcome: null,
    stagnantStreak: 0,
    lastProgressSignature: "",
  };

  const tools = buildCoordinatorTools(deps, progress);
  const kea = await createKeaSession({
    role: "coordinator",
    tools,
    systemPrompt: COORDINATOR_SYSTEM_PROMPT,
  });
  const unbridge = bridgeSessionToStore(kea.session, "coordinator", deps.store);

  try {
    while (!signal.aborted) {
      if (progress.signalledDone) break;
      if (progress.pagesProcessed >= deps.maxPages) {
        log.info(
          { pagesProcessed: progress.pagesProcessed, maxPages: deps.maxPages },
          "max pages reached",
        );
        progress.outcome = progress.outcome ?? "completed";
        progress.doneReason = progress.doneReason || `reached maxPages=${deps.maxPages}`;
        break;
      }

      const state = await collectCoordinatorState(deps);
      const effectiveState = applyScenarioCap(state, deps, progress);
      if (!hasPendingWork(effectiveState)) {
        log.info("no work remains; coordinator exiting");
        progress.outcome = progress.outcome ?? "completed";
        progress.doneReason = progress.doneReason || "all queues drained";
        break;
      }

      const signatureBefore = progressSignature(state, progress);
      if (!progress.lastProgressSignature) {
        progress.lastProgressSignature = signatureBefore;
      }

      const userMsg = renderState(state);
      let promptFailed = false;
      try {
        await kea.session.prompt(userMsg);
      } catch (err) {
        promptFailed = true;
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "session prompt failed; falling back",
        );
        await runFallbackAction(deps, progress, state);
      }

      let usedFallback = promptFailed;
      if (!promptFailed) {
        const calls = countLastTurnToolCalls(kea);
        if (calls.unknownNames.length > 0) {
          log.warn({ unknownNames: calls.unknownNames }, "LLM emitted unknown tool calls");
        }
        if (calls.known === 0 && !progress.signalledDone) {
          log.warn(
            { totalCalls: calls.total, unknownNames: calls.unknownNames },
            "no actionable tool call this turn; running deterministic fallback",
          );
          await runFallbackAction(deps, progress, state);
          usedFallback = true;
        }
      }

      if (progress.signalledDone) break;

      // Stagnation guard. The LLM may emit valid-looking tool calls that
      // run cleanly but advance no counter (e.g. discover_features against a
      // URL whose features are already covered). At STAGNATION_RESCUE the
      // deterministic fallback runs even if the LLM produced output, so we
      // exhaust the fallback chain before failing. Only at STAGNATION_LIMIT
      // do we abort.
      const stateAfter = await collectCoordinatorState(deps);
      const signatureAfter = progressSignature(stateAfter, progress);
      if (signatureAfter === progress.lastProgressSignature) {
        progress.stagnantStreak += 1;
        log.warn(
          { streak: progress.stagnantStreak, limit: STAGNATION_LIMIT, usedFallback },
          "coordinator turn made no progress",
        );
        if (progress.stagnantStreak >= STAGNATION_RESCUE && !usedFallback) {
          log.warn(
            { streak: progress.stagnantStreak, rescueAt: STAGNATION_RESCUE },
            "coordinator stagnation rescue: forcing deterministic fallback",
          );
          await runFallbackAction(deps, progress, stateAfter);
          const rescuedState = await collectCoordinatorState(deps);
          const rescuedSignature = progressSignature(rescuedState, progress);
          if (rescuedSignature !== progress.lastProgressSignature) {
            progress.stagnantStreak = 0;
            progress.lastProgressSignature = rescuedSignature;
            continue;
          }
        }
        if (progress.stagnantStreak >= STAGNATION_LIMIT) {
          const reason = `no progress for ${progress.stagnantStreak} consecutive turns despite fallback; aborting as failed`;
          log.error({ reason }, "coordinator stagnation guard triggered");
          progress.signalledDone = true;
          progress.outcome = "failed";
          progress.doneReason = reason;
          break;
        }
      } else {
        progress.stagnantStreak = 0;
        progress.lastProgressSignature = signatureAfter;
      }
    }
  } finally {
    unbridge();
    kea.dispose();
  }

  return {
    status: progress.outcome ?? "completed",
    reason: progress.doneReason || "coordinator exited without an explicit reason",
  };
}
