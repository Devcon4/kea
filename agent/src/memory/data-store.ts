import type { Result } from "../result.js";
import type { PageStatus, SitemapEntry, SitemapStats, Severity, FindingsStats } from "@kea/shared";
export { normalizeUrl } from "@kea/shared";
export type { PageStatus, SitemapEntry, SitemapStats, Severity, FindingsStats };

export type Finding = {
  id: number;
  url: string;
  agentId: string;
  action: string;
  result: string;
  severity: Severity;
  timestamp: number;
};

export type UpsertPageInput = {
  url: string;
  title: string;
  links: string[];
  status: PageStatus;
  discoveredAt?: number;
  visitedAt?: number | null;
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

export interface DataStore {
  upsertPage(entry: UpsertPageInput): Promise<Result<void, Error>>;
  visitPage(url: string, title: string, links: string[]): Promise<Result<void, Error>>;
  discoverPage(url: string): Promise<Result<void, Error>>;
  getPage(url: string): Promise<Result<SitemapEntry | null, Error>>;
  getUnvisitedPages(limit?: number): Promise<Result<SitemapEntry[], Error>>;
  getUntestedPages(limit?: number): Promise<Result<SitemapEntry[], Error>>;
  getAllPages(): Promise<Result<SitemapEntry[], Error>>;
  getSitemapStats(): Promise<Result<SitemapStats, Error>>;
  invalidatePage(url: string): Promise<Result<void, Error>>;
  removePage(url: string): Promise<Result<void, Error>>;
  addFinding(finding: AddFindingInput): Promise<Result<number, Error>>;
  getFindings(url?: string): Promise<Result<Finding[], Error>>;
  getFindingsStats(): Promise<Result<FindingsStats, Error>>;
  addMessage(message: AddMessageInput): Promise<Result<number, Error>>;
  close(): void;
}
