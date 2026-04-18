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

const AGENT_META: Record<string, { label: string; color: string; icon: string }> = {
  coordinator: { label: "Coordinator", color: "var(--color-primary)", icon: "🧠" },
  navigator:   { label: "Navigator",   color: "var(--color-info)",    icon: "🧭" },
  tester:      { label: "Tester",      color: "var(--color-warning)", icon: "🔍" },
};

function agentMeta(agentId: string) {
  return AGENT_META[agentId] ?? { label: agentId, color: "var(--color-text-muted)", icon: "🤖" };
}

@customElement("kea-chat-thread")
class KeaChatThread extends LitElement {
  @property({ type: Array }) messages: ChatMessage[] = [];
  @state() private expandedThinking = new Set<number>();

  private toggleThinking(id: number) {
    const next = new Set(this.expandedThinking);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedThinking = next;
  }

  static styles = css`
    :host {
      display: block;
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
      gap: var(--space-md);
    }

    /* ── Message bubble ───────────────────────────── */
    .message {
      display: flex;
      gap: var(--space-md);
      align-items: flex-start;
    }

    .avatar {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-full);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--text-lg);
      flex-shrink: 0;
      border: 2px solid var(--color-border);
      background: var(--color-surface);
    }

    .bubble {
      flex: 1;
      min-width: 0;
    }

    .bubble-header {
      display: flex;
      align-items: baseline;
      gap: var(--space-sm);
      margin-bottom: var(--space-xs);
    }

    .agent-name {
      font-size: var(--text-sm);
      font-weight: var(--font-weight-semibold);
    }

    .timestamp {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
    }

    .bubble-content {
      font-size: var(--text-sm);
      line-height: var(--leading-relaxed);
      word-break: break-word;
      color: var(--color-text);
    }

    .bubble-content p {
      margin: 0 0 var(--space-xs);
    }

    .bubble-content p:last-child {
      margin-bottom: 0;
    }

    .bubble-content pre {
      background: var(--color-bg);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      padding: var(--space-sm);
      overflow-x: auto;
      margin: var(--space-xs) 0;
    }

    .bubble-content code {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
    }

    .bubble-content :not(pre) > code {
      background: var(--color-bg);
      padding: 1px 4px;
      border-radius: var(--radius-sm);
    }

    .bubble-content ul,
    .bubble-content ol {
      margin: var(--space-xs) 0;
      padding-left: var(--space-lg);
    }

    .bubble-content blockquote {
      margin: var(--space-xs) 0;
      padding-left: var(--space-md);
      border-left: 3px solid var(--color-border);
      color: var(--color-text-muted);
    }

    /* ── Thinking toggle ──────────────────────────── */
    .thinking-toggle {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
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
      font-size: 10px;
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

    return html`
      <div class="thread">
        ${this.messages.map((msg) => this.renderMessage(msg))}
      </div>
    `;
  }

  private renderMessage(msg: ChatMessage) {
    const meta = agentMeta(msg.agentId);
    const isExpanded = this.expandedThinking.has(msg.id);

    return html`
      <div class="message">
        <div class="avatar" style="border-color: ${meta.color}">
          ${meta.icon}
        </div>
        <div class="bubble">
          <div class="bubble-header">
            <span class="agent-name" style="color: ${meta.color}">${meta.label}</span>
            <span class="timestamp">${timeAgo(msg.timestamp)}</span>
          </div>
          <div class="bubble-content">${unsafeHTML(marked.parse(msg.content) as string)}</div>
          ${msg.thinking
            ? html`
                <button
                  class="thinking-toggle"
                  @click=${() => this.toggleThinking(msg.id)}
                >
                  <span
                    class="thinking-arrow"
                    ?data-open=${isExpanded}
                  >▶</span>
                  Thinking
                </button>
                ${isExpanded
                  ? html`<div class="thinking-content">${msg.thinking}</div>`
                  : nothing}
              `
            : nothing}
        </div>
      </div>
    `;
  }
}
