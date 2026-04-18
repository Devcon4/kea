/**
 * Session Repository — Persistence for the Session aggregate.
 *
 * This is an infrastructure concern. It knows how to map domain objects
 * to/from the database but contains NO business logic. All invariant
 * checks live in domain.ts; the repository just persists what the
 * domain layer produces.
 */

import { eq, asc, desc, and, sql, count } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { sessions, sitemap, findings, messages } from "../db/schema.js";
import type {
  Session,
  SitemapEntry,
  SitemapStats,
  Finding,
  FindingsStats,
  ChatMessage,
  PageStatus,
  Severity,
} from "@kea/shared";

export type SessionRepository = ReturnType<typeof createSessionRepository>;

export function createSessionRepository(db: Database) {
  // ── Aggregate root persistence ───────────────────────

  async function list(): Promise<Session[]> {
    const rows = await db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.startedAt));
    return rows as Session[];
  }

  async function getById(id: string): Promise<Session | undefined> {
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id));
    return row as Session | undefined;
  }

  async function save(session: Session): Promise<Session> {
    const [row] = await db
      .insert(sessions)
      .values({
        id: session.id,
        targetUrl: session.targetUrl,
        status: session.status,
        maxPages: session.maxPages,
        config: session.config,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
      })
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          status: sql`excluded.status`,
          completedAt: sql`excluded.completed_at`,
          config: sql`excluded.config`,
          maxPages: sql`excluded.max_pages`,
        },
      })
      .returning();
    return row as Session;
  }

  // ── Queries (read-side, no invariants) ───────────────

  async function getStats(
    sessionId: string,
  ): Promise<{ sitemap: SitemapStats; findings: FindingsStats }> {
    const sitemapRows = await db
      .select({ status: sitemap.status, count: count() })
      .from(sitemap)
      .where(eq(sitemap.sessionId, sessionId))
      .groupBy(sitemap.status);

    const sitemapStats: SitemapStats = {
      total: 0,
      discovered: 0,
      visited: 0,
      tested: 0,
    };
    for (const row of sitemapRows) {
      const key = row.status as keyof Omit<SitemapStats, "total">;
      sitemapStats[key] = row.count;
      sitemapStats.total += row.count;
    }

    const findingsRows = await db
      .select({ severity: findings.severity, count: count() })
      .from(findings)
      .where(eq(findings.sessionId, sessionId))
      .groupBy(findings.severity);

    const findingsStats: FindingsStats = {
      info: 0,
      warning: 0,
      error: 0,
      critical: 0,
    };
    for (const row of findingsRows) {
      findingsStats[row.severity as Severity] = row.count;
    }

    return { sitemap: sitemapStats, findings: findingsStats };
  }

  // ── Owned entity persistence: Sitemap ────────────────

  async function listPages(
    sessionId: string,
    opts?: { status?: string; limit?: number },
  ): Promise<SitemapEntry[]> {
    let query = db
      .select()
      .from(sitemap)
      .where(
        opts?.status
          ? and(
              eq(sitemap.sessionId, sessionId),
              eq(sitemap.status, opts.status),
            )
          : eq(sitemap.sessionId, sessionId),
      )
      .orderBy(asc(sitemap.discoveredAt));

    if (opts?.limit) query = query.limit(opts.limit) as typeof query;

    const rows = await query;

    return rows.map((r) => ({
      url: r.url,
      title: r.title,
      links: r.links as string[],
      status: r.status as PageStatus,
      discoveredAt: r.discoveredAt,
      visitedAt: r.visitedAt,
    }));
  }

  async function savePage(
    sessionId: string,
    entry: SitemapEntry,
  ): Promise<void> {
    await db
      .insert(sitemap)
      .values({
        sessionId,
        url: entry.url,
        title: entry.title,
        links: entry.links,
        status: entry.status,
        discoveredAt: entry.discoveredAt,
        visitedAt: entry.visitedAt,
      })
      .onConflictDoUpdate({
        target: [sitemap.sessionId, sitemap.url],
        set: {
          title: sql`COALESCE(NULLIF(excluded.title, ''), ${sitemap.title})`,
          links: sql`excluded.links`,
          status: sql`excluded.status`,
          visitedAt: sql`excluded.visited_at`,
        },
      });
  }

  async function savePageDiscovery(
    sessionId: string,
    entry: SitemapEntry,
  ): Promise<void> {
    await db
      .insert(sitemap)
      .values({
        sessionId,
        url: entry.url,
        title: entry.title,
        links: entry.links,
        status: entry.status,
        discoveredAt: entry.discoveredAt,
        visitedAt: entry.visitedAt,
      })
      .onConflictDoNothing();
  }

  async function savePageVisit(
    sessionId: string,
    entry: SitemapEntry,
  ): Promise<void> {
    await db
      .insert(sitemap)
      .values({
        sessionId,
        url: entry.url,
        title: entry.title,
        links: entry.links,
        status: entry.status,
        discoveredAt: entry.discoveredAt,
        visitedAt: entry.visitedAt,
      })
      .onConflictDoUpdate({
        target: [sitemap.sessionId, sitemap.url],
        set: {
          title: sql`COALESCE(NULLIF(excluded.title, ''), ${sitemap.title})`,
          links: sql`excluded.links`,
          visitedAt: sql`excluded.visited_at`,
          status: sql`CASE WHEN ${sitemap.status} = 'tested' THEN 'tested' ELSE 'visited' END`,
        },
      });
  }

  async function removePage(
    sessionId: string,
    url: string,
  ): Promise<void> {
    await db
      .delete(sitemap)
      .where(
        and(eq(sitemap.sessionId, sessionId), eq(sitemap.url, url)),
      );
  }

  // ── Owned entity persistence: Findings ───────────────

  async function listFindings(
    sessionId: string,
    url?: string,
  ): Promise<Finding[]> {
    const rows = await db
      .select()
      .from(findings)
      .where(
        url
          ? and(
              eq(findings.sessionId, sessionId),
              eq(findings.url, url),
            )
          : eq(findings.sessionId, sessionId),
      )
      .orderBy(desc(findings.timestamp));

    return rows as Finding[];
  }

  async function saveFinding(
    data: Omit<Finding, "id">,
  ): Promise<Finding> {
    const [row] = await db
      .insert(findings)
      .values(data)
      .returning();
    return row as Finding;
  }

  // ── Owned entity persistence: Messages ────────────

  async function listMessages(
    sessionId: string,
  ): Promise<ChatMessage[]> {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.timestamp));

    return rows as ChatMessage[];
  }

  async function saveMessage(
    data: Omit<ChatMessage, "id">,
  ): Promise<ChatMessage> {
    const [row] = await db
      .insert(messages)
      .values(data)
      .returning();
    return row as ChatMessage;
  }

  return {
    // aggregate root
    list,
    getById,
    save,
    // queries
    getStats,
    // owned: sitemap
    listPages,
    savePage,
    savePageDiscovery,
    savePageVisit,
    removePage,
    // owned: findings
    listFindings,
    saveFinding,
    // owned: messages
    listMessages,
    saveMessage,
  };
}
