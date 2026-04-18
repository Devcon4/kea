import { z } from "zod";

// -- Page / Sitemap --

export const PageStatusSchema = z.enum(["discovered", "visited", "tested"]);

export const UpsertPageSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  links: z.array(z.string()),
  status: PageStatusSchema,
  discoveredAt: z.number().optional(),
  visitedAt: z.number().nullable().optional(),
});

export const VisitPageSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  links: z.array(z.string()),
});

export const DiscoverPageSchema = z.object({
  url: z.string().url(),
});

// -- Findings --

export const SeveritySchema = z.enum(["info", "warning", "error", "critical"]);

export const CreateFindingSchema = z.object({
  url: z.string().url(),
  agentId: z.string().min(1),
  action: z.string().min(1),
  result: z.string().min(1),
  severity: SeveritySchema,
  timestamp: z.number(),
});

// -- Chat Messages --

export const CreateChatMessageSchema = z.object({
  agentId: z.string().min(1),
  content: z.string().min(1),
  thinking: z.string().nullable().optional(),
  timestamp: z.number(),
});

// -- Sessions --

export const SessionStatusSchema = z.enum(["running", "completed", "failed"]);

export const CreateSessionSchema = z.object({
  id: z.string().min(1),
  targetUrl: z.string().url(),
  status: SessionStatusSchema.default("running"),
  maxPages: z.number().int().positive(),
  config: z.record(z.string(), z.unknown()).default({}),
  startedAt: z.number(),
  completedAt: z.number().nullable().optional(),
});

export const UpdateSessionSchema = z.object({
  status: SessionStatusSchema.optional(),
  completedAt: z.number().nullable().optional(),
});
