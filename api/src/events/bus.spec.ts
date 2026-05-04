import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@kea/shared";
import { createEventBus } from "./bus.js";

describe("EventBus", () => {
  it("delivers refresh events to all subscribers", () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    bus.emit({ kind: "sitemap", sessionId: "s1", at: 1 });

    expect(a).toHaveBeenCalledWith({ kind: "sitemap", sessionId: "s1", at: 1 });
    expect(b).toHaveBeenCalledWith({ kind: "sitemap", sessionId: "s1", at: 1 });
  });

  it("delivers messages events with the saved row payload", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.subscribe(listener);

    const message: ChatMessage = {
      id: 7,
      sessionId: "s1",
      agentId: "coordinator",
      content: "hi",
      thinking: null,
      timestamp: 100,
    };
    bus.emit({ kind: "messages", sessionId: "s1", at: 100, message });

    expect(listener).toHaveBeenCalledWith({
      kind: "messages",
      sessionId: "s1",
      at: 100,
      message,
    });
  });

  it("unsubscribe stops delivery without affecting other listeners", () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = bus.subscribe(a);
    bus.subscribe(b);

    unsubA();
    bus.emit({ kind: "session-list", at: 1 });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount()).toBe(1);
  });

  it("a throwing listener does not block other listeners", () => {
    const bus = createEventBus();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    const survivor = vi.fn();
    bus.subscribe(survivor);

    bus.emit({ kind: "findings", sessionId: "s1", at: 1 });

    expect(survivor).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing inside a listener does not skip subsequent listeners for THIS emit", () => {
    const bus = createEventBus();
    let unsub: () => void = () => {};
    const a = vi.fn(() => unsub());
    const b = vi.fn();
    unsub = bus.subscribe(a);
    bus.subscribe(b);

    bus.emit({ kind: "session-list", at: 1 });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount()).toBe(1);
  });
});
