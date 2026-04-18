import { describe, it, expect } from "vitest";
import {
  CreateFindingSchema,
  CreateSessionSchema,
  UpsertPageSchema,
  VisitPageSchema,
  DiscoverPageSchema,
  UpdateSessionSchema,
} from "./schemas.js";

describe("schemas", () => {
  describe("UpsertPageSchema", () => {
    it("should validate a valid upsert page input", () => {
      const result = UpsertPageSchema.safeParse({
        url: "http://example.com/",
        title: "Home",
        links: ["http://example.com/about"],
        status: "visited",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid status", () => {
      const result = UpsertPageSchema.safeParse({
        url: "http://example.com/",
        title: "Home",
        links: [],
        status: "invalid",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("VisitPageSchema", () => {
    it("should validate a visit page input", () => {
      const result = VisitPageSchema.safeParse({
        url: "http://example.com/",
        title: "Home",
        links: [],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("DiscoverPageSchema", () => {
    it("should validate a discover page input", () => {
      const result = DiscoverPageSchema.safeParse({
        url: "http://example.com/page",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("CreateFindingSchema", () => {
    it("should validate a valid finding", () => {
      const result = CreateFindingSchema.safeParse({
        url: "http://example.com/",
        agentId: "tester-1",
        action: "click button",
        result: "500 error returned",
        severity: "error",
        timestamp: Date.now(),
      });
      expect(result.success).toBe(true);
    });

    it("should reject missing fields", () => {
      const result = CreateFindingSchema.safeParse({
        url: "http://example.com/",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("CreateSessionSchema", () => {
    it("should validate a valid session", () => {
      const result = CreateSessionSchema.safeParse({
        id: "session-abc",
        targetUrl: "http://example.com",
        maxPages: 50,
        startedAt: Date.now(),
      });
      expect(result.success).toBe(true);
    });
  });

  describe("UpdateSessionSchema", () => {
    it("should validate a partial update", () => {
      const result = UpdateSessionSchema.safeParse({
        status: "completed",
        completedAt: Date.now(),
      });
      expect(result.success).toBe(true);
    });

    it("should allow empty update", () => {
      const result = UpdateSessionSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});
