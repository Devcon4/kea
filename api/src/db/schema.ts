import {
  pgTable,
  text,
  integer,
  bigint,
  serial,
  index,
  jsonb,
  primaryKey,
  varchar,
} from "drizzle-orm/pg-core";

// -- Sessions --

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  targetUrl: text("target_url").notNull(),
  status: text("status").notNull().default("running"),
  maxPages: integer("max_pages").notNull().default(50),
  config: jsonb("config").notNull().default({}),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
  completedAt: bigint("completed_at", { mode: "number" }),
});

// -- Sitemap --

export const sitemap = pgTable(
  "sitemap",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title").notNull().default(""),
    links: jsonb("links").notNull().default([]),
    status: text("status").notNull().default("discovered"),
    discoveredAt: bigint("discovered_at", { mode: "number" }).notNull(),
    visitedAt: bigint("visited_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.url] }),
    index("idx_sitemap_session_status").on(table.sessionId, table.status),
  ],
);

// -- Findings --

export const findings = pgTable(
  "findings",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    agentId: text("agent_id").notNull(),
    action: text("action").notNull(),
    result: text("result").notNull(),
    severity: text("severity").notNull().default("info"),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_findings_session").on(table.sessionId),
    index("idx_findings_severity").on(table.severity),
  ],
);

// -- Messages (agent chat log) --

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 32 }).notNull(),
    content: text("content").notNull(),
    thinking: text("thinking"),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_messages_session").on(table.sessionId),
    index("idx_messages_session_ts").on(table.sessionId, table.timestamp),
  ],
);
