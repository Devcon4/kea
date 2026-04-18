import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, asc, desc, sql, count } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryCatchSync } from "../result.js";
import type { Result } from "../result.js";
import { createLogger } from "../logger.js";
import { sitemap, findings, agentMessages } from "./schema.js";
import { normalizeUrl } from "@kea/shared";

const log = createLogger("store");

/** Resolve the drizzle migrations folder relative to the project root. */
function defaultMigrationsPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  // In dev: src/memory/store.ts → ../../drizzle
  // Bundled: dist/index.js → ../drizzle
  // Walk up until we find the drizzle folder
  let dir = thisDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "drizzle");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  // Fallback: assume project root is one level up from dist/
  return path.join(path.dirname(thisDir), "drizzle");
}

// -- Domain Types --

export type PageStatus = "discovered" | "visited" | "tested";

export type SitemapEntry = {
  url: string;
  title: string;
  links: string[];
  status: PageStatus;
  discoveredAt: number;
  visitedAt: number | null;
};

export type Severity = "info" | "warning" | "error" | "critical";

export type Finding = {
  id?: number;
  url: string;
  agentId: string;
  action: string;
  result: string;
  severity: Severity;
  timestamp: number;
};

export type SitemapStats = {
  total: number;
  discovered: number;
  visited: number;
  tested: number;
};

export type FindingsStats = Record<Severity, number>;

// -- Row mapping --

type SitemapRow = typeof sitemap.$inferSelect;
type FindingRow = typeof findings.$inferSelect;

const toSitemapEntry = (row: SitemapRow): SitemapEntry => ({
  url: row.url,
  title: row.title,
  links: JSON.parse(row.links) as string[],
  status: row.status as PageStatus,
  discoveredAt: row.discoveredAt,
  visitedAt: row.visitedAt,
});

const toFinding = (row: FindingRow): Finding => ({
  id: row.id,
  url: row.url,
  agentId: row.agentId,
  action: row.action,
  result: row.result,
  severity: row.severity as Severity,
  timestamp: row.timestamp,
});

// -- Store --

export type UpsertPageInput = {
  url: string;
  title: string;
  links: string[];
  status: PageStatus;
  discoveredAt?: number;
  visitedAt?: number | null;
};

export type StoreOptions = {
  /** Path to the SQLite database file (or ":memory:"). */
  dbPath?: string;
  /** Path to drizzle migrations folder. Defaults to <projectRoot>/drizzle. */
  migrationsPath?: string;
};

export class Store {
  private sqlite: Database.Database;
  private db: BetterSQLite3Database;

  constructor(opts?: StoreOptions | string) {
    // Accept a bare string for backwards compat (dbPath shorthand).
    const { dbPath, migrationsPath } =
      typeof opts === "string" ? { dbPath: opts, migrationsPath: undefined } : (opts ?? {});

    const resolvedPath = dbPath ?? path.join(process.cwd(), "kea.db");
    this.sqlite = new Database(resolvedPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.db = drizzle(this.sqlite);

    const migrationsFolder = migrationsPath ?? defaultMigrationsPath();
    migrate(this.db, { migrationsFolder });
    this.normalizeStoredUrls();
    log.info({ path: resolvedPath, migrationsFolder }, "store initialized");
  }

  // -- Sitemap --

  upsertPage(entry: UpsertPageInput): Result<void, Error> {
    return tryCatchSync(() => {
      const url = normalizeUrl(entry.url);
      this.db
        .insert(sitemap)
        .values({
          url,
          title: entry.title,
          links: JSON.stringify(entry.links),
          status: entry.status,
          discoveredAt: entry.discoveredAt ?? Date.now(),
          visitedAt: entry.visitedAt ?? null,
        })
        .onConflictDoUpdate({
          target: sitemap.url,
          set: {
            title: sql`COALESCE(excluded.title, ${sitemap.title})`,
            links: sql`excluded.links`,
            status: sql`excluded.status`,
            visitedAt: sql`excluded.visited_at`,
          },
        })
        .run();
    });
  }

  /** Mark a page as visited, updating title and links. Never downgrades status from "tested". */
  visitPage(url: string, title: string, links: string[]): Result<void, Error> {
    return tryCatchSync(() => {
      const normalized = normalizeUrl(url);
      this.db
        .insert(sitemap)
        .values({
          url: normalized,
          title,
          links: JSON.stringify(links),
          status: "visited",
          discoveredAt: Date.now(),
          visitedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: sitemap.url,
          set: {
            title: sql`COALESCE(NULLIF(excluded.title, ''), ${sitemap.title})`,
            links: sql`excluded.links`,
            visitedAt: sql`excluded.visited_at`,
            // Only upgrade: discovered → visited. Never downgrade tested → visited.
            status: sql`CASE WHEN ${sitemap.status} = 'tested' THEN 'tested' ELSE 'visited' END`,
          },
        })
        .run();
    });
  }

  /** Insert a discovered URL only if it doesn't already exist (never downgrades status). */
  discoverPage(url: string): Result<void, Error> {
    return tryCatchSync(() => {
      this.db
        .insert(sitemap)
        .values({
          url: normalizeUrl(url),
          title: "",
          links: "[]",
          status: "discovered",
          discoveredAt: Date.now(),
          visitedAt: null,
        })
        .onConflictDoNothing()
        .run();
    });
  }

  getPage(url: string): Result<SitemapEntry | null, Error> {
    return tryCatchSync(() => {
      const row = this.db
        .select()
        .from(sitemap)
        .where(eq(sitemap.url, normalizeUrl(url)))
        .get();
      if (!row) return null;
      return toSitemapEntry(row);
    });
  }

  getUnvisitedPages(limit = 10): Result<SitemapEntry[], Error> {
    return tryCatchSync(() => {
      const rows = this.db
        .select()
        .from(sitemap)
        .where(eq(sitemap.status, "discovered"))
        .orderBy(asc(sitemap.discoveredAt))
        .limit(limit)
        .all();
      return rows.map(toSitemapEntry);
    });
  }

  /** Get pages that have been visited but not yet tested. */
  getUntestedPages(limit = 10): Result<SitemapEntry[], Error> {
    return tryCatchSync(() => {
      const rows = this.db
        .select()
        .from(sitemap)
        .where(eq(sitemap.status, "visited"))
        .orderBy(asc(sitemap.visitedAt))
        .limit(limit)
        .all();
      return rows.map(toSitemapEntry);
    });
  }

  /** Reset a page back to "discovered" so it will be re-crawled and re-tested. */
  invalidatePage(url: string): Result<void, Error> {
    return tryCatchSync(() => {
      this.db
        .update(sitemap)
        .set({ status: "discovered", visitedAt: null })
        .where(eq(sitemap.url, normalizeUrl(url)))
        .run();
    });
  }

  /** Remove a page from the sitemap entirely. */
  removePage(url: string): Result<void, Error> {
    return tryCatchSync(() => {
      this.db
        .delete(sitemap)
        .where(eq(sitemap.url, normalizeUrl(url)))
        .run();
    });
  }

  getAllPages(): Result<SitemapEntry[], Error> {
    return tryCatchSync(() => {
      const rows = this.db
        .select()
        .from(sitemap)
        .orderBy(asc(sitemap.discoveredAt))
        .all();
      return rows.map(toSitemapEntry);
    });
  }

  getSitemapStats(): Result<SitemapStats, Error> {
    return tryCatchSync(() => {
      const rows = this.db
        .select({ status: sitemap.status, count: count() })
        .from(sitemap)
        .groupBy(sitemap.status)
        .all();

      const stats: SitemapStats = { total: 0, discovered: 0, visited: 0, tested: 0 };
      for (const row of rows) {
        const key = row.status as keyof Omit<SitemapStats, "total">;
        stats[key] = row.count;
        stats.total += row.count;
      }
      return stats;
    });
  }

  // -- Findings --

  addFinding(finding: Omit<Finding, "id">): Result<number, Error> {
    return tryCatchSync(() => {
      const result = this.db
        .insert(findings)
        .values({
          url: finding.url,
          agentId: finding.agentId,
          action: finding.action,
          result: finding.result,
          severity: finding.severity,
          timestamp: finding.timestamp,
        })
        .returning({ id: findings.id })
        .get();
      return result.id;
    });
  }

  getFindings(url?: string): Result<Finding[], Error> {
    return tryCatchSync(() => {
      const query = this.db
        .select()
        .from(findings)
        .orderBy(desc(findings.timestamp));

      const rows = url
        ? query.where(eq(findings.url, url)).all()
        : query.all();

      return rows.map(toFinding);
    });
  }

  getFindingsStats(): Result<FindingsStats, Error> {
    return tryCatchSync(() => {
      const rows = this.db
        .select({ severity: findings.severity, count: count() })
        .from(findings)
        .groupBy(findings.severity)
        .all();

      const stats: FindingsStats = { info: 0, warning: 0, error: 0, critical: 0 };
      for (const row of rows) {
        stats[row.severity as Severity] = row.count;
      }
      return stats;
    });
  }

  // -- Messages --

  addMessage(message: { agentId: string; content: string; thinking?: string | null; timestamp: number }): Result<number, Error> {
    return tryCatchSync(() => {
      const result = this.db
        .insert(agentMessages)
        .values({
          agentId: message.agentId,
          content: message.content,
          thinking: message.thinking ?? null,
          timestamp: message.timestamp,
        })
        .returning({ id: agentMessages.id })
        .get();
      return result.id;
    });
  }

  /**
   * Normalize all stored URLs in the sitemap.
   * Deduplicates entries like "http://host:80/" → "http://host/" left over from prior runs.
   */
  private normalizeStoredUrls(): void {
    const rows = this.db.select({ url: sitemap.url }).from(sitemap).all();
    for (const row of rows) {
      const normalized = normalizeUrl(row.url);
      if (normalized === row.url) continue;

      // Check if the normalized form already exists
      const existing = this.db
        .select()
        .from(sitemap)
        .where(eq(sitemap.url, normalized))
        .get();

      if (existing) {
        // Normalized URL exists — delete the un-normalized duplicate
        this.db.delete(sitemap).where(eq(sitemap.url, row.url)).run();
      } else {
        // No normalized entry — update the URL in-place
        this.db.update(sitemap).set({ url: normalized }).where(eq(sitemap.url, row.url)).run();
      }
    }
  }

  close(): void {
    this.sqlite.close();
  }
}
