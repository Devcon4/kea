// -- Page / Sitemap --

export type PageStatus = "discovered" | "visited" | "tested";

export type SitemapEntry = {
  url: string;
  title: string;
  links: string[];
  status: PageStatus;
  discoveredAt: number;
  visitedAt: number | null;
};

export type SitemapStats = {
  total: number;
  discovered: number;
  visited: number;
  tested: number;
};

// -- Findings --

export type Severity = "info" | "warning" | "error" | "critical";

export type Finding = {
  id: number;
  sessionId: string;
  url: string;
  agentId: string;
  action: string;
  result: string;
  severity: Severity;
  timestamp: number;
};

export type FindingsStats = Record<Severity, number>;

// -- Sessions --

export type SessionStatus = "running" | "completed" | "failed";

export type Session = {
  id: string;
  targetUrl: string;
  status: SessionStatus;
  maxPages: number;
  config: Record<string, unknown>;
  startedAt: number;
  completedAt: number | null;
};

// -- Chat Messages --

export type ChatMessage = {
  id: number;
  sessionId: string;
  agentId: string;
  content: string;
  thinking: string | null;
  timestamp: number;
};

// -- Helpers --

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (
      (u.protocol === "http:" && u.port === "80") ||
      (u.protocol === "https:" && u.port === "443")
    ) {
      u.port = "";
    }
    if (u.pathname === "") u.pathname = "/";
    return u.toString();
  } catch {
    return raw;
  }
}
