import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";

// Reset modules between tests to handle env var changes
describe("logger", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports a root logger", async () => {
    const mod = await import("./logger.js");
    expect(mod.logger).toBeDefined();
    expect(typeof mod.logger.info).toBe("function");
  });

  it("createLogger returns a child logger", async () => {
    const mod = await import("./logger.js");
    const child = mod.createLogger("test-module");
    expect(typeof child.info).toBe("function");
    expect(typeof child.error).toBe("function");
  });

  it("Logger type is compatible with pino.Logger", async () => {
    const mod = await import("./logger.js");
    const child: pino.Logger = mod.createLogger("typed");
    expect(child).toBeDefined();
  });
});
