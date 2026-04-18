import type { Session } from "@kea/shared";
import { tryCatch } from "@kea/shared";
import type { Result } from "../result.js";
import type {
  DataStore,
  SitemapEntry,
  SitemapStats,
  FindingsStats,
  UpsertPageInput,
  AddFindingInput,
  AddMessageInput,
  Finding,
} from "./data-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("api-client");

export type ApiClientOptions = {
  baseUrl: string;
  sessionId: string;
};

export class ApiClient implements DataStore {
  private baseUrl: string;
  private sessionId: string;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.sessionId = opts.sessionId;
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/sessions/${this.sessionId}${path}`;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return fetch(this.url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async put(path: string, body: unknown): Promise<Response> {
    return fetch(this.url(path), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // -- Session lifecycle --

  async registerSession(session: Omit<Session, "completedAt"> & { completedAt?: number | null }): Promise<Result<Session, Error>> {
    return tryCatch(async () => {
      const res = await fetch(`${this.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session),
      });
      if (!res.ok) throw new Error(`register session failed: ${res.status}`);
      return (await res.json()) as Session;
    });
  }

  async completeSession(status: "completed" | "failed"): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await fetch(
        `${this.baseUrl}/api/sessions/${this.sessionId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status, completedAt: Date.now() }),
        },
      );
      if (!res.ok) throw new Error(`complete session failed: ${res.status}`);
    });
  }

  // -- Sitemap --

  async upsertPage(entry: UpsertPageInput): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.put("/sitemap", {
        url: entry.url,
        title: entry.title,
        links: entry.links,
        status: entry.status,
        discoveredAt: entry.discoveredAt,
        visitedAt: entry.visitedAt ?? null,
      });
      if (!res.ok) throw new Error(`upsertPage failed: ${res.status}`);
    });
  }

  async visitPage(
    url: string,
    title: string,
    links: string[],
  ): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.post("/sitemap/visit", {
        url,
        title,
        links,
      });
      if (!res.ok) throw new Error(`visitPage failed: ${res.status}`);
    });
  }

  async discoverPage(url: string): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.post("/sitemap/discover", {
        url,
      });
      if (!res.ok) throw new Error(`discoverPage failed: ${res.status}`);
    });
  }

  async getPage(url: string): Promise<Result<SitemapEntry | null, Error>> {
    return tryCatch(async () => {
      const res = await fetch(
        `${this.url("/sitemap")}?status=&limit=&url=${encodeURIComponent(url)}`,
      );
      if (!res.ok) throw new Error(`getPage failed: ${res.status}`);
      const pages = (await res.json()) as SitemapEntry[];
      return pages.find((p) => p.url === url) ?? null;
    });
  }

  async getUnvisitedPages(limit = 10): Promise<Result<SitemapEntry[], Error>> {
    return tryCatch(async () => {
      const res = await fetch(
        `${this.url("/sitemap")}?status=discovered&limit=${limit}`,
      );
      if (!res.ok) throw new Error(`getUnvisitedPages failed: ${res.status}`);
      return (await res.json()) as SitemapEntry[];
    });
  }

  async getUntestedPages(limit = 10): Promise<Result<SitemapEntry[], Error>> {
    return tryCatch(async () => {
      const res = await fetch(
        `${this.url("/sitemap")}?status=visited&limit=${limit}`,
      );
      if (!res.ok) throw new Error(`getUntestedPages failed: ${res.status}`);
      return (await res.json()) as SitemapEntry[];
    });
  }

  async getAllPages(): Promise<Result<SitemapEntry[], Error>> {
    return tryCatch(async () => {
      const res = await fetch(this.url("/sitemap"));
      if (!res.ok) throw new Error(`getAllPages failed: ${res.status}`);
      return (await res.json()) as SitemapEntry[];
    });
  }

  async getSitemapStats(): Promise<Result<SitemapStats, Error>> {
    return tryCatch(async () => {
      const res = await fetch(this.url("/stats"));
      if (!res.ok) throw new Error(`getSitemapStats failed: ${res.status}`);
      const body = (await res.json()) as {
        sitemap: SitemapStats;
        findings: FindingsStats;
      };
      return body.sitemap;
    });
  }

  async invalidatePage(url: string): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.put("/sitemap", {
        url,
        title: "",
        links: [],
        status: "discovered",
        visitedAt: null,
      });
      if (!res.ok) throw new Error(`invalidatePage failed: ${res.status}`);
    });
  }

  async removePage(url: string): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await fetch(
        `${this.url("/sitemap")}?url=${encodeURIComponent(url)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`removePage failed: ${res.status}`);
    });
  }

  // -- Findings --

  async addFinding(finding: AddFindingInput): Promise<Result<number, Error>> {
    return tryCatch(async () => {
      const res = await this.post("/findings", finding);
      if (!res.ok) throw new Error(`addFinding failed: ${res.status}`);
      const body = (await res.json()) as Finding;
      return body.id;
    });
  }

  async getFindings(url?: string): Promise<Result<Finding[], Error>> {
    return tryCatch(async () => {
      const query = url ? `?url=${encodeURIComponent(url)}` : "";
      const res = await fetch(`${this.url("/findings")}${query}`);
      if (!res.ok) throw new Error(`getFindings failed: ${res.status}`);
      return (await res.json()) as Finding[];
    });
  }

  async getFindingsStats(): Promise<Result<FindingsStats, Error>> {
    return tryCatch(async () => {
      const res = await fetch(this.url("/stats"));
      if (!res.ok) throw new Error(`getFindingsStats failed: ${res.status}`);
      const body = (await res.json()) as {
        sitemap: SitemapStats;
        findings: FindingsStats;
      };
      return body.findings;
    });
  }

  // -- Messages --

  async addMessage(message: AddMessageInput): Promise<Result<number, Error>> {
    return tryCatch(async () => {
      const res = await this.post("/messages", message);
      if (!res.ok) throw new Error(`addMessage failed: ${res.status}`);
      const body = (await res.json()) as { id: number };
      return body.id;
    });
  }

  // -- No-op close (no local DB to close) --
  close(): void {
    log.info("api client closed (no-op)");
  }
}
