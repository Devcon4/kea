/**
 * Session Aggregate — Pure domain logic.
 *
 * All business rules for the Session bounded context live here.
 * No database, no HTTP, no framework imports — just types and functions
 * that encode what operations are valid and when.
 *
 * The Session is the aggregate root. SitemapEntry and Finding are owned
 * entities that can only be created/modified through the aggregate.
 */

import { Ok, Err, normalizeUrl } from "@kea/shared";
import type { Result } from "@kea/shared";
import type {
  Session,
  SessionStatus,
  SitemapEntry,
  PageStatus,
  Finding,
  ChatMessage,
  Severity,
} from "@kea/shared";

// ── Re-exports for convenience ─────────────────────────
export type { Session, SitemapEntry, Finding, ChatMessage };
export { normalizeUrl };

// ── Input types for domain operations ──────────────────

export type CreateSessionInput = {
  id: string;
  targetUrl: string;
  status?: SessionStatus;
  maxPages: number;
  config?: Record<string, unknown>;
  startedAt: number;
  completedAt?: number | null;
};

export type AddFindingInput = {
  url: string;
  agentId: string;
  action: string;
  result: string;
  severity: Severity;
  timestamp: number;
};

export type AddMessageInput = {
  agentId: string;
  content: string;
  thinking?: string | null;
  timestamp: number;
};

export type VisitPageInput = {
  url: string;
  title: string;
  links: string[];
};

// ── Factory ────────────────────────────────────────────

export function createSession(
  input: CreateSessionInput,
): Result<Session, string> {
  if (!input.id) return Err("Session id is required");
  if (!input.targetUrl) return Err("Target URL is required");
  if (input.maxPages < 1) return Err("maxPages must be at least 1");

  return Ok({
    id: input.id,
    targetUrl: normalizeUrl(input.targetUrl),
    status: input.status ?? "running",
    maxPages: input.maxPages,
    config: input.config ?? {},
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? null,
  });
}

// ── Guards ─────────────────────────────────────────────

function assertRunning(session: Session): Result<void, string> {
  if (session.status !== "running") {
    return Err(
      `Session ${session.id} is '${session.status}' — only running sessions accept changes`,
    );
  }
  return Ok(undefined);
}

// ── Commands on the aggregate ──────────────────────────

/**
 * Transition a session to 'completed'.
 * Returns a new Session value — does NOT mutate.
 */
export function completeSession(
  session: Session,
  completedAt = Date.now(),
): Result<Session, string> {
  const guard = assertRunning(session);
  if (!guard.ok) return guard;

  return Ok({
    ...session,
    status: "completed" as SessionStatus,
    completedAt,
  });
}

/**
 * Transition a session to 'failed'.
 */
export function failSession(
  session: Session,
  completedAt = Date.now(),
): Result<Session, string> {
  const guard = assertRunning(session);
  if (!guard.ok) return guard;

  return Ok({
    ...session,
    status: "failed" as SessionStatus,
    completedAt,
  });
}

/**
 * Create a Finding owned by this session.
 * Enforces: session must be running, URL is normalized.
 */
export function addFinding(
  session: Session,
  input: AddFindingInput,
): Result<Omit<Finding, "id">, string> {
  const guard = assertRunning(session);
  if (!guard.ok) return guard;

  if (!input.url) return Err("Finding URL is required");
  if (!input.agentId) return Err("agentId is required");

  return Ok({
    sessionId: session.id,
    url: normalizeUrl(input.url),
    agentId: input.agentId,
    action: input.action,
    result: input.result,
    severity: input.severity,
    timestamp: input.timestamp,
  });
}

/**
 * Mark a page as visited, creating or updating the sitemap entry.
 * Enforces: session must be running, URL normalized, timestamp set.
 */
export function visitPage(
  session: Session,
  input: VisitPageInput,
): Result<SitemapEntry, string> {
  const guard = assertRunning(session);
  if (!guard.ok) return guard;

  const now = Date.now();
  return Ok({
    url: normalizeUrl(input.url),
    title: input.title,
    links: input.links,
    status: "visited" as PageStatus,
    discoveredAt: now,
    visitedAt: now,
  });
}

/**
 * Record that a URL was discovered (but not yet visited).
 * Enforces: session must be running, URL normalized.
 */
export function discoverPage(
  session: Session,
  url: string,
): Result<SitemapEntry, string> {
  const guard = assertRunning(session);
  if (!guard.ok) return guard;

  return Ok({
    url: normalizeUrl(url),
    title: "",
    links: [] as string[],
    status: "discovered" as PageStatus,
    discoveredAt: Date.now(),
    visitedAt: null,
  });
}

/**
 * Generic upsert — for the agent's bulk page updates.
 * Enforces: session must be running.
 */
export function upsertPage(
  session: Session,
  input: {
    url: string;
    title: string;
    links: string[];
    status: PageStatus;
    discoveredAt?: number;
    visitedAt?: number | null;
  },
): Result<SitemapEntry, string> {
  const guard = assertRunning(session);
  if (!guard.ok) return guard;

  const now = Date.now();
  return Ok({
    url: normalizeUrl(input.url),
    title: input.title,
    links: input.links,
    status: input.status,
    discoveredAt: input.discoveredAt ?? now,
    visitedAt: input.visitedAt ?? null,
  });
}

/**
 * Record an agent chat message.
 * Enforces: session must be running.
 */
export function addMessage(
  session: Session,
  input: AddMessageInput,
): Result<Omit<ChatMessage, "id">, string> {
  const guard = assertRunning(session);
  if (!guard.ok) return guard;

  if (!input.agentId) return Err("agentId is required");

  return Ok({
    sessionId: session.id,
    agentId: input.agentId,
    content: input.content,
    thinking: input.thinking ?? null,
    timestamp: input.timestamp,
  });
}
