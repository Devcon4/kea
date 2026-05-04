import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { Marked } from "marked";
import { timeAgo } from "../utils.js";

export type ChatMessage = {
  id: number;
  sessionId: string;
  agentId: string;
  content: string;
  thinking: string | null;
  timestamp: number;
};

const marked = new Marked({
  async: false,
  gfm: true,
  breaks: true,
});

const AGENT_META: Record<string, { label: string; color: string }> = {
  coordinator: { label: "Coordinator", color: "var(--color-primary)" },
  "planner-discover": { label: "Planner · discover", color: "var(--color-info)" },
  "planner-author": { label: "Planner · author", color: "var(--color-info)" },
  navigator: { label: "Navigator", color: "var(--color-info)" },
  tester: { label: "Tester", color: "var(--color-warning)" },
  "tester-judge": { label: "Tester · judge", color: "var(--color-warning)" },
};

function agentMeta(agentId: string) {
  return AGENT_META[agentId] ?? { label: agentId, color: "var(--color-text-muted)" };
}

const COORDINATOR_ID = "coordinator";

/**
 * 10-frame braille spinner (matches Pi's terminal idiom). Rendered as a
 * vertical filmstrip; CSS animates `translateY` through the frames so we
 * don't need a JS timer ticking on the dashboard.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function renderSpinner() {
  return html`<span class="spinner" aria-hidden="true"
    ><span class="spinner-strip"
      >${SPINNER_FRAMES.map((f) => html`<span class="spinner-frame">${f}</span>`)}</span
    ></span
  >`;
}

/** Tool call lines persisted by the bridge look like `→ tool_name({...})`. */
const TOOL_CALL_RE = /^→\s*([a-z_][\w]*)\s*\((.*)\)\s*$/s;

type ToolCallView = {
  kind: "tool_call";
  name: string;
  argsCompact: string;
  argsPretty: string;
  parsed: unknown;
};

type ProseView = {
  kind: "prose";
  htmlContent: string;
};

type MessageView = {
  message: ChatMessage;
  meta: ReturnType<typeof agentMeta>;
  body: ToolCallView | ProseView;
};

type SubAgentBlock = {
  kind: "sub_agent";
  agentId: string;
  meta: ReturnType<typeof agentMeta>;
  messages: MessageView[];
};

type CoordinatorEntry = (MessageView & { kind: "coordinator_message" }) | SubAgentBlock;

type CoordinatorTurn = {
  startedAt: number;
  /** Ordered children: coordinator messages and nested sub-agent runs. */
  entries: CoordinatorEntry[];
};

type Thread =
  | { kind: "turn"; turn: CoordinatorTurn; key: string }
  | { kind: "orphan"; block: SubAgentBlock; key: string };

function classifyMessage(msg: ChatMessage): MessageView {
  const meta = agentMeta(msg.agentId);
  const trimmed = msg.content.trim();
  const match = TOOL_CALL_RE.exec(trimmed);
  if (match) {
    const args = parseToolArgs(match[2]);
    return {
      message: msg,
      meta,
      body: {
        kind: "tool_call",
        name: match[1],
        argsCompact: args.compact,
        argsPretty: args.pretty,
        parsed: args.parsed,
      },
    };
  }
  return {
    message: msg,
    meta,
    body: { kind: "prose", htmlContent: marked.parse(msg.content) as string },
  };
}

function parseToolArgs(raw: string): { compact: string; pretty: string; parsed: unknown } {
  const trimmed = raw.trim();
  if (!trimmed) return { compact: "", pretty: "", parsed: undefined };
  try {
    const parsed = JSON.parse(trimmed);
    return {
      compact: JSON.stringify(parsed),
      pretty: JSON.stringify(parsed, null, 2),
      parsed,
    };
  } catch {
    return { compact: trimmed, pretty: trimmed, parsed: undefined };
  }
}

/**
 * Build a one-line, human-readable label for a turn's primary tool call so
 * the turn header can say what is happening (e.g. "Authoring plan for feature
 * #12") instead of just "Turn 23". Returns null when no tool call is known.
 */
function summarizeToolCall(name: string, parsed: unknown): string {
  const args = isObject(parsed) ? parsed : {};
  const url = typeof args.url === "string" ? args.url : null;
  const featureId = typeof args.featureId === "number" ? args.featureId : null;
  const scenarioId = typeof args.scenarioId === "number" ? args.scenarioId : null;
  const reason = typeof args.reason === "string" ? args.reason : null;

  switch (name) {
    case "navigate":
      return url ? `Navigating ${shortUrl(url)}` : "Navigating";
    case "discover_features":
      return url ? `Discovering features on ${shortUrl(url)}` : "Discovering features";
    case "author_plan":
      return featureId !== null ? `Authoring plan for feature #${featureId}` : "Authoring plan";
    case "revalidate_feature":
      return featureId !== null ? `Revalidating feature #${featureId}` : "Revalidating feature";
    case "test":
      return scenarioId !== null ? `Running scenario #${scenarioId}` : "Running scenario";
    case "invalidate":
      return url ? `Invalidating ${shortUrl(url)}` : "Invalidating page";
    case "remove":
      return url ? `Removing ${shortUrl(url)}` : "Removing page";
    case "done":
      return reason ? `Finished — ${reason}` : "Finished";
    case "fail_session":
      return reason ? `Aborting — ${reason}` : "Aborting session";
    default:
      return name;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}${u.search}`;
  } catch {
    return url;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Find the primary tool call in a turn (the first coordinator message that is
 * a tool call) and produce a human-readable label for it. Falls back to a
 * generic "Thinking…" / first-words snippet so the header is never empty.
 */
function summarizeTurn(turn: CoordinatorTurn): string {
  for (const entry of turn.entries) {
    if (entry.kind !== "coordinator_message") continue;
    if (entry.body.kind === "tool_call") {
      return summarizeToolCall(entry.body.name, entry.body.parsed);
    }
  }
  for (const entry of turn.entries) {
    if (entry.kind !== "coordinator_message") continue;
    if (entry.body.kind === "prose") {
      const raw = entry.message.content.trim();
      const words = raw.split(/\s+/).slice(0, 8).join(" ");
      if (words.length === 0) continue;
      return words.length < raw.length ? `${words}…` : words;
    }
  }
  return "Thinking…";
}

function isTerminalTurn(turn: CoordinatorTurn): boolean {
  for (const entry of turn.entries) {
    if (entry.kind !== "coordinator_message") continue;
    if (entry.body.kind !== "tool_call") continue;
    if (entry.body.name === "done" || entry.body.name === "fail_session") return true;
  }
  return false;
}

/**
 * Group a flat, time-ordered message list into coordinator turns with sub-agent
 * runs nested under their parent coordinator tool call.
 *
 * The bridge writes the coordinator's `→ tool_name(...)` row at the moment the
 * call is dispatched (see agent/src/pi/bridge.ts), so any sub-agent messages
 * that follow until the next coordinator entry belong to that tool call.
 */
function buildThreads(messages: ChatMessage[]): Thread[] {
  const threads: Thread[] = [];
  let currentTurn: CoordinatorTurn | null = null;
  let currentSub: SubAgentBlock | null = null;
  let leadingOrphan: SubAgentBlock | null = null;

  const flushSub = () => {
    if (!currentSub) return;
    if (currentTurn) {
      currentTurn.entries.push(currentSub);
    } else {
      // Sub-agent activity before any coordinator turn — orphan block.
      threads.push({
        kind: "orphan",
        block: currentSub,
        key: `orphan-${currentSub.messages[0].message.id}`,
      });
    }
    currentSub = null;
    leadingOrphan = null;
  };

  for (const msg of messages) {
    const view = classifyMessage(msg);

    if (msg.agentId === COORDINATOR_ID) {
      flushSub();
      currentTurn = { startedAt: msg.timestamp, entries: [] };
      threads.push({
        kind: "turn",
        turn: currentTurn,
        key: `turn-${msg.id}`,
      });
      currentTurn.entries.push({ ...view, kind: "coordinator_message" });
      continue;
    }

    if (!currentSub || currentSub.agentId !== msg.agentId) {
      flushSub();
      currentSub = {
        kind: "sub_agent",
        agentId: msg.agentId,
        meta: view.meta,
        messages: [],
      };
      if (!currentTurn) leadingOrphan = currentSub;
    }
    currentSub.messages.push(view);
  }
  flushSub();
  void leadingOrphan;

  return threads;
}


/**
 * localStorage key + helpers for the chat sort direction toggle.
 * Falls back gracefully when storage is unavailable (private mode, SSR,
 * disabled by browser policy) — the UI defaults to oldest-first and the
 * preference simply doesn't persist.
 */
const SORT_DIR_KEY = "kea.chatSortDirection";
type SortDir = "newest-last" | "newest-first";
function readSortDir(): SortDir {
  try {
    const v = localStorage.getItem(SORT_DIR_KEY);
    if (v === "newest-first" || v === "newest-last") return v;
  } catch {
    /* storage unavailable */
  }
  return "newest-last";
}
function writeSortDir(v: SortDir): void {
  try {
    localStorage.setItem(SORT_DIR_KEY, v);
  } catch {
    /* storage unavailable */
  }
}
@customElement("kea-chat-thread")
class KeaChatThread extends LitElement {
  @property({ type: Array }) messages: ChatMessage[] = [];
  @property({ type: Boolean, reflect: true }) live = false;
  @state() private expandedThinking = new Set<number>();
  @state() private expandedToolArgs = new Set<number>();
  /**
   * Display order for coordinator turns / orphan sub-agent blocks. Within a
   * single turn the children stay in chronological order — only the outer
   * sequence flips. Persisted across sessions in localStorage so an operator's
   * preference survives reloads and tab switches.
   */
  @state() private sortDir: "newest-last" | "newest-first" = readSortDir();

  private toggleThinking(id: number) {
    const next = new Set(this.expandedThinking);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedThinking = next;
  }

  private toggleToolArgs(id: number) {
    const next = new Set(this.expandedToolArgs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedToolArgs = next;
  }

  private toggleSortDir() {
    this.sortDir = this.sortDir === "newest-last" ? "newest-first" : "newest-last";
    writeSortDir(this.sortDir);
  }

  static styles = css`
    :host {
      display: block;
    }

    /*
     * Pure-CSS auto-scroll. The page is the scroll container; we opt every
     * element inside the message thread out of being a scroll-anchor
     * candidate so the browser locks onto the explicit .scroll-anchor
     * sentinel that sits after the last message. When new messages stream in,
     * the sentinel stays pinned in the viewport so the scroll position
     * follows the bottom — but only while the sentinel is actually visible.
     * If the user scrolls up to read history the sentinel leaves the viewport
     * and the browser falls back to anchoring on whatever is on screen, so we
     * do not yank them back to the bottom.
     *
     * https://drafts.csswg.org/css-scroll-anchoring/
     */
    .thread,
    .thread * {
      overflow-anchor: none;
    }

    .scroll-anchor {
      height: 1px;
      pointer-events: none;
    }

    .empty {
      color: var(--color-text-muted);
      text-align: center;
      padding: var(--space-2xl);
      font-size: var(--text-sm);
    }

    .thread {
      display: flex;
      flex-direction: column;
      gap: var(--space-lg);
    }

    /* ── Sort toolbar ─────────────────────────────── */
    .thread-toolbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: var(--space-sm);
    }

    .sort-toggle {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      font-size: var(--text-xs);
      font-weight: var(--font-weight-medium);
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-full);
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      font-family: inherit;
      transition: all var(--duration-fast);
    }
    .sort-toggle:hover {
      border-color: var(--color-text-muted);
      color: var(--color-text);
    }
    .sort-toggle[aria-pressed="true"] {
      border-color: var(--color-primary);
      background: var(--color-primary-muted);
      color: var(--color-primary);
    }
    .sort-toggle-icon {
      font-family: var(--font-mono);
      font-weight: var(--font-weight-semibold);
    }

    /* ── Coordinator turn ─────────────────────────── */
    .turn {
      position: relative;
      padding-left: var(--space-lg);
      border-left: 2px solid var(--color-border);
      transition: border-color var(--duration-fast);
    }

    .turn[data-active] {
      border-left-color: var(--color-primary);
    }

    .turn-header {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin-bottom: var(--space-sm);
      font-size: var(--text-sm);
      color: var(--color-text);
    }

    .turn-summary {
      font-weight: var(--font-weight-semibold);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .turn-live,
    .sub-agent-live {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      font-size: var(--text-xs);
      font-weight: var(--font-weight-medium);
      color: var(--color-primary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }

    .sub-agent-live {
      margin-left: auto;
    }

    /*
     * Braille spinner: a vertical filmstrip clipped to one row, walked by
     * a transform translateY under steps() timing; each span is one frame.
     * Inheriting line-height keeps the row height locked so the clip matches.
     */
    .spinner {
      display: inline-block;
      width: 1ch;
      height: 1em;
      line-height: 1;
      overflow: hidden;
      vertical-align: text-bottom;
      font-family: var(--font-mono);
      color: currentColor;
    }

    .spinner-strip {
      display: flex;
      flex-direction: column;
      animation: spinner-walk 0.8s steps(10) infinite;
    }

    .spinner-frame {
      height: 1em;
      line-height: 1;
    }

    @keyframes spinner-walk {
      to {
        transform: translateY(-10em);
      }
    }

    .turn-meta {
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      flex-shrink: 0;
    }

    .turn-ordinal {
      font-variant-numeric: tabular-nums;
      padding: 1px var(--space-2xs);
      border-radius: var(--radius-sm);
      background: var(--color-bg);
      border: 1px solid var(--color-border-subtle);
    }

    .turn-entries {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }

    /* ── Sub-agent block ──────────────────────────── */
    .sub-agent {
      margin-left: var(--space-lg);
      padding: var(--space-sm) var(--space-md);
      border-left: 2px solid var(--color-border-subtle);
      background: var(--color-bg);
      border-radius: 0 var(--radius-md) var(--radius-md) 0;
      transition: border-color var(--duration-fast);
    }

    .sub-agent[data-active] {
      border-left-color: var(--color-primary);
    }

    .sub-agent-header {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      margin-bottom: var(--space-xs);
    }

    .sub-agent-label {
      font-weight: var(--font-weight-semibold);
    }

    .sub-agent-count {
      color: var(--color-text-faint);
    }

    .sub-agent-entries {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }

    /* ── Tool call row ────────────────────────────── */
    .tool-call {
      display: flex;
      flex-direction: column;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--color-text);
    }

    .tool-call-row {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      width: 100%;
      padding: var(--space-2xs) var(--space-xs);
      margin: 0;
      background: none;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition:
        background var(--duration-fast),
        border-color var(--duration-fast);
    }

    .tool-call-row:disabled {
      cursor: default;
    }

    .tool-call-row:not(:disabled):hover {
      background: var(--color-bg);
      border-color: var(--color-border-subtle);
    }

    .tool-call[data-expanded] .tool-call-row {
      background: var(--color-bg);
      border-color: var(--color-border-subtle);
    }

    .tool-call-arrow {
      color: var(--color-text-faint);
      flex-shrink: 0;
      user-select: none;
      width: 1ch;
      transition: transform var(--duration-fast);
    }

    .tool-call-arrow[data-open] {
      transform: rotate(90deg);
    }

    .tool-call-name {
      font-weight: var(--font-weight-semibold);
      color: var(--color-primary);
      flex-shrink: 0;
    }

    .tool-call-args {
      color: var(--color-text-muted);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tool-call-args-empty {
      color: var(--color-text-faint);
    }

    .tool-call-time {
      color: var(--color-text-faint);
      flex-shrink: 0;
      font-family: var(--font-sans);
    }

    .tool-call-pretty {
      margin: var(--space-2xs) 0 0 calc(1ch + var(--space-sm) + var(--space-xs));
      padding: var(--space-sm) var(--space-md);
      background: var(--color-bg);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      color: var(--color-text);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow: auto;
    }

    /* ── Prose message ────────────────────────────── */
    .prose {
      display: flex;
      gap: var(--space-md);
      align-items: flex-start;
    }

    .prose-body {
      flex: 1;
      min-width: 0;
    }

    .prose-meta {
      display: flex;
      align-items: baseline;
      gap: var(--space-sm);
      margin-bottom: var(--space-2xs);
      font-size: var(--text-xs);
      color: var(--color-text-faint);
    }

    .prose-agent {
      font-weight: var(--font-weight-semibold);
    }

    .prose-content {
      font-size: var(--text-sm);
      line-height: var(--leading-relaxed);
      word-break: break-word;
      color: var(--color-text);
    }

    .prose-content p {
      margin: 0 0 var(--space-xs);
    }
    .prose-content p:last-child {
      margin-bottom: 0;
    }
    .prose-content pre {
      background: var(--color-bg);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      padding: var(--space-sm);
      overflow-x: auto;
      margin: var(--space-xs) 0;
    }
    .prose-content code {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
    }
    .prose-content :not(pre) > code {
      background: var(--color-bg);
      padding: 1px 4px;
      border-radius: var(--radius-sm);
    }
    .prose-content ul,
    .prose-content ol {
      margin: var(--space-xs) 0;
      padding-left: var(--space-lg);
    }
    .prose-content blockquote {
      margin: var(--space-xs) 0;
      padding-left: var(--space-md);
      border-left: 3px solid var(--color-border);
      color: var(--color-text-muted);
    }

    /* ── Thinking toggle ──────────────────────────── */
    .thinking-toggle {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2xs);
      margin-top: var(--space-xs);
      padding: 0;
      border: none;
      background: none;
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      cursor: pointer;
      font-family: inherit;
      transition: color var(--duration-fast);
    }
    .thinking-toggle:hover {
      color: var(--color-text-muted);
    }
    .thinking-arrow {
      font-size: 9px;
      transition: transform var(--duration-fast);
    }
    .thinking-arrow[data-open] {
      transform: rotate(90deg);
    }
    .thinking-content {
      margin-top: var(--space-xs);
      padding: var(--space-sm) var(--space-md);
      background: var(--color-bg);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      font-size: var(--text-xs);
      line-height: var(--leading-relaxed);
      color: var(--color-text-muted);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--font-mono);
      max-height: 300px;
      overflow-y: auto;
    }
  `;

  render() {
    if (this.messages.length === 0) {
      return html`<p class="empty">No agent messages yet.</p>`;
    }

    const threads = buildThreads(this.messages);
    const lastIdx = threads.length - 1;
    // Reorder for display only; keep the original chronological identity
    // (`origIdx`) so ordinals stay 1…N from the start of the conversation
    // and the "is this the active live turn" check still points at the most
    // recent turn regardless of which end of the list it renders on.
    const indexed = threads.map((t, origIdx) => ({ t, origIdx }));
    const ordered = this.sortDir === "newest-first" ? [...indexed].reverse() : indexed;
    const reversed = this.sortDir === "newest-first";

    const anchor = html`<div class="scroll-anchor" aria-hidden="true"></div>`;

    return html`
      <div class="thread-toolbar">
        <button
          type="button"
          class="sort-toggle"
          @click=${() => this.toggleSortDir()}
          aria-pressed=${reversed}
          title=${reversed ? "Showing newest first — click to flip" : "Showing oldest first — click to flip"}
        >
          <span class="sort-toggle-icon" aria-hidden="true">${reversed ? "↓" : "↑"}</span>
          ${reversed ? "Newest first" : "Oldest first"}
        </button>
      </div>
      <div class="thread">
        ${reversed ? anchor : nothing}
        ${ordered.map(({ t, origIdx }) => {
          const isLast = origIdx === lastIdx;
          return t.kind === "turn"
            ? this.renderTurn(t.turn, origIdx + 1, t.key, isLast)
            : this.renderOrphanSubAgent(t.block, t.key);
        })}
        ${reversed ? nothing : anchor}
      </div>
    `;
  }

  private renderTurn(turn: CoordinatorTurn, ordinal: number, key: string, isLast: boolean) {
    const meta = agentMeta(COORDINATOR_ID);
    const summary = summarizeTurn(turn);
    const terminated = isTerminalTurn(turn);
    const active = isLast && this.live && !terminated;
    return html`
      <section class="turn" data-key=${key} ?data-active=${active}>
        <header class="turn-header">
          <span class="turn-summary" style="color: ${meta.color}">${summary}</span>
          ${active
            ? html`<span class="turn-live" title="In progress">${renderSpinner()} live</span>`
            : nothing}
          <span class="turn-meta">
            <span class="turn-ordinal" title="Turn ${ordinal}">#${ordinal}</span>
            <span class="turn-time">${timeAgo(turn.startedAt)}</span>
          </span>
        </header>
        <div class="turn-entries">
          ${turn.entries.map((entry, entryIdx) => {
            const isLastEntry = entryIdx === turn.entries.length - 1;
            const entryActive = active && isLastEntry;
            return entry.kind === "coordinator_message"
              ? this.renderMessageView(entry, COORDINATOR_ID)
              : this.renderSubAgent(entry, entryActive);
          })}
        </div>
      </section>
    `;
  }

  private renderOrphanSubAgent(block: SubAgentBlock, key: string) {
    return html`<div data-key=${key}>${this.renderSubAgent(block, false)}</div>`;
  }

  private renderSubAgent(block: SubAgentBlock, active: boolean) {
    return html`
      <div class="sub-agent" ?data-active=${active}>
        <header class="sub-agent-header">
          <span class="sub-agent-label" style="color: ${block.meta.color}">
            ${block.meta.label}
          </span>
          <span class="sub-agent-count"
            >· ${block.messages.length} ${block.messages.length === 1 ? "message" : "messages"}
          </span>
          ${active
            ? html`<span class="sub-agent-live" title="Working">${renderSpinner()} working</span>`
            : nothing}
        </header>
        <div class="sub-agent-entries">
          ${block.messages.map((m) => this.renderMessageView(m, block.agentId))}
        </div>
      </div>
    `;
  }

  private renderMessageView(view: MessageView, ownerAgentId: string) {
    return view.body.kind === "tool_call"
      ? this.renderToolCall(view, view.body)
      : this.renderProse(view, view.body, ownerAgentId);
  }

  private renderToolCall(view: MessageView, body: ToolCallView) {
    const expanded = this.expandedToolArgs.has(view.message.id);
    const hasArgs = body.argsCompact.length > 0;
    return html`
      <div class="tool-call" ?data-expanded=${expanded}>
        <button
          type="button"
          class="tool-call-row"
          ?disabled=${!hasArgs}
          aria-expanded=${expanded ? "true" : "false"}
          @click=${() => hasArgs && this.toggleToolArgs(view.message.id)}
          title=${hasArgs ? (expanded ? "Collapse args" : "Expand args") : ""}
        >
          <span class="tool-call-arrow" ?data-open=${expanded}>${hasArgs ? "▸" : "·"}</span>
          <span class="tool-call-name">${body.name}</span>
          ${hasArgs
            ? html`<span class="tool-call-args">(${body.argsCompact})</span>`
            : html`<span class="tool-call-args tool-call-args-empty">()</span>`}
          <span class="tool-call-time">${timeAgo(view.message.timestamp)}</span>
        </button>
        ${expanded && hasArgs
          ? html`<pre class="tool-call-pretty">${body.argsPretty}</pre>`
          : nothing}
      </div>
    `;
  }

  private renderProse(view: MessageView, body: ProseView, ownerAgentId: string) {
    const meta = view.meta;
    const isExpanded = this.expandedThinking.has(view.message.id);
    // Hide the avatar/label when prose belongs to the same agent as the block
    // owner (sub-agent groups already show the label in the header).
    const showHeader = view.message.agentId !== ownerAgentId;
    return html`
      <div class="prose">
        <div class="prose-body">
          ${showHeader
            ? html`<div class="prose-meta">
                <span class="prose-agent" style="color: ${meta.color}"> ${meta.label} </span>
                <span>${timeAgo(view.message.timestamp)}</span>
              </div>`
            : nothing}
          <div class="prose-content">${unsafeHTML(body.htmlContent)}</div>
          ${view.message.thinking
            ? html`
                <button
                  class="thinking-toggle"
                  @click=${() => this.toggleThinking(view.message.id)}
                >
                  <span class="thinking-arrow" ?data-open=${isExpanded}>▶</span>
                  Thinking
                </button>
                ${isExpanded
                  ? html`<div class="thinking-content">${view.message.thinking}</div>`
                  : nothing}
              `
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "kea-chat-thread": KeaChatThread;
  }
}
