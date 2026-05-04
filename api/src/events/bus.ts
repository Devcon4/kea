/**
 * In-process event bus carrying session-scoped invalidation signals to SSE
 * subscribers. Replaces the prior 2-second message poll and the dashboard's
 * 5-second list poll with a push channel: every mutation in the API emits a
 * single event, every connected dashboard learns about it on the next tick.
 *
 * Scope is one process. The API is single-replica per ADR-020/topology; if we
 * fan out, swap this `EventBus` for Postgres `LISTEN/NOTIFY` and call sites
 * stay the same. Event shape is the wire contract — keep it stable.
 */

import type { ChatMessage } from "@kea/shared";

/**
 * Each kind names a slice of session state the dashboard fetches separately.
 * The client reacts by re-issuing the matching fetch (idempotent re-fetch is
 * simpler than reconciling diffs and avoids ordering races).
 *
 * `messages` is the only kind that carries a payload — chat messages are
 * append-only, small, and useful in real time. Everything else signals
 * "your view is stale; refetch".
 */
export type RefreshKind = "session" | "sitemap" | "findings" | "features";

export type AppEvent =
  | { kind: RefreshKind; sessionId: string; at: number }
  | { kind: "messages"; sessionId: string; at: number; message: ChatMessage }
  | { kind: "session-list"; at: number };

type Listener = (event: AppEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AppEvent): void {
    // Snapshot the listener set so an unsubscribe inside a handler doesn't
    // mutate the iteration we're walking.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A bad listener never blocks others from receiving the event.
      }
    }
  }

  /** Test helper: number of currently-attached listeners. */
  listenerCount(): number {
    return this.listeners.size;
  }
}

export function createEventBus(): EventBus {
  return new EventBus();
}
