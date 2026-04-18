import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// -- Sitemap table --

export const sitemap = sqliteTable(
  "sitemap",
  {
    url: text("url").primaryKey(),
    title: text("title").notNull().default(""),
    links: text("links").notNull().default("[]"),
    status: text("status").notNull().default("discovered"),
    discoveredAt: integer("discovered_at").notNull(),
    visitedAt: integer("visited_at"),
  },
  (table) => [
    index("idx_sitemap_status").on(table.status),
  ],
);

// -- Findings table --

export const findings = sqliteTable(
  "findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    url: text("url").notNull(),
    agentId: text("agent_id").notNull(),
    action: text("action").notNull(),
    result: text("result").notNull(),
    severity: text("severity").notNull().default("info"),
    timestamp: integer("timestamp").notNull(),
  },
  (table) => [
    index("idx_findings_url").on(table.url),
    index("idx_findings_severity").on(table.severity),
  ],
);

// -- Messages table --

export const agentMessages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    content: text("content").notNull(),
    thinking: text("thinking"),
    timestamp: integer("timestamp").notNull(),
  },
  (table) => [
    index("idx_messages_ts").on(table.timestamp),
  ],
);
