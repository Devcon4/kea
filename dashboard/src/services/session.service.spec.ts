import { describe, it, expect, beforeEach } from "vitest";
import { SessionService, type SessionWithStats } from "./session.service.js";
import { firstValueFrom } from "rxjs";

const makeSession = (overrides: Partial<SessionWithStats> = {}): SessionWithStats => ({
  id: "test-1",
  targetUrl: "http://example.com",
  status: "running",
  maxPages: 50,
  config: {},
  pagesVisited: 5,
  pagesTotal: 20,
  findingsCount: 2,
  startedAt: Date.now(),
  completedAt: null,
  ...overrides,
});

describe("SessionService", () => {
  let service: SessionService;

  beforeEach(() => {
    service = new SessionService();
  });

  it("should start with an empty session list", () => {
    expect(service.sessions).toEqual([]);
  });

  it("should set sessions", async () => {
    const sessions = [makeSession(), makeSession({ id: "test-2" })];
    service.setSessions(sessions);

    expect(service.sessions).toHaveLength(2);
    const emitted = await firstValueFrom(service.sessions$);
    expect(emitted).toHaveLength(2);
  });

  it("should add a session", () => {
    service.addSession(makeSession());
    service.addSession(makeSession({ id: "test-2" }));

    expect(service.sessions).toHaveLength(2);
  });

  it("should update a session", () => {
    service.addSession(makeSession());
    service.updateSession("test-1", { status: "completed", completedAt: Date.now() });

    expect(service.sessions[0].status).toBe("completed");
    expect(service.sessions[0].completedAt).toBeDefined();
  });

  it("should remove a session", () => {
    service.addSession(makeSession());
    service.addSession(makeSession({ id: "test-2" }));
    service.removeSession("test-1");

    expect(service.sessions).toHaveLength(1);
    expect(service.sessions[0].id).toBe("test-2");
  });

  it("should compute active count", async () => {
    service.setSessions([
      makeSession({ id: "1", status: "running" }),
      makeSession({ id: "2", status: "completed" }),
      makeSession({ id: "3", status: "running" }),
    ]);

    const count = await firstValueFrom(service.activeCount$);
    expect(count).toBe(2);
  });

  it("should compute total findings", async () => {
    service.setSessions([
      makeSession({ id: "1", findingsCount: 3 }),
      makeSession({ id: "2", findingsCount: 7 }),
    ]);

    const total = await firstValueFrom(service.totalFindings$);
    expect(total).toBe(10);
  });
});
