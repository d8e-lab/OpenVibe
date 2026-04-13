import { ChatMessage, ToolCall, ApiConfig } from '../types';
import { sendChatMessage } from '../api';
import { SessionManager } from './SessionManager';

/**
 * Owns conversation state and operations on top of {@link SessionManager}.
 *
 * **Multi-agent:** use {@link buildMessagesForLlm} as the single place to assemble
 * `[system, ...turns]` before `sendChatMessage`. Later you can inject handoff
 * transcripts, agent IDs, or merge parallel branches without touching the webview.
 */
export class ConversationService {
  constructor(
    private readonly _session: SessionManager,
    private readonly _getApiConfig: () => ApiConfig,
    private readonly _post: (msg: any) => void
  ) {}

  getCurrentMessages(): ChatMessage[] {
    return this._session.getCurrentMessages();
  }

  addMessage(msg: ChatMessage): void {
    this._session.addMessage(msg);
  }

  setCurrentMessages(messages: ChatMessage[]): void {
    this._session.setCurrentMessages(messages);
  }

  getCurrentSessionId(): string {
    return this._session.getCurrentSessionId();
  }

  saveCurrentSession(): void {
    this._session.saveCurrentSession();
  }

  /**
   * Assembles the message list for the main LLM call. Replace or wrap this when
   * adding orchestrators, sub-agents, or shared scratchpad context.
   */
  buildMessagesForLlm(systemPrompt: string): ChatMessage[] {
    return [{ role: 'system', content: systemPrompt }, ...this.getCurrentMessages()];
  }

  /**
   * Removes assistant turns whose tool_calls never received matching tool results.
   */
  sanitizeIncompleteToolCalls(): void {
    const messages = this._session.getCurrentMessages();
    let changed = false;
    const clean: ChatMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const requiredIds = new Set(msg.tool_calls.map((tc: ToolCall) => tc.id));
        const rest = messages.slice(i + 1);
        const respondedIds = new Set(
          rest
            .filter((m: ChatMessage) => m.role === 'tool' && m.tool_call_id)
            .map((m: ChatMessage) => m.tool_call_id!)
        );

        if (!Array.from(requiredIds).every(id => respondedIds.has(id))) {
          changed = true;
          let j = i + 1;
          while (j < messages.length && messages[j].role === 'tool') {
            j++;
          }
          i = j - 1;
          continue;
        }
      }

      clean.push(msg);
    }

    if (changed) {
      this._session.setCurrentMessages(clean);
      this._session.saveCurrentSession();
    }
  }

  /**
   * Replace history with an LLM-generated summary (tool / auto compact).
   */
  async compactHistory(triggeredByTokenLimit = false): Promise<string> {
    const messages = this._session.getCurrentMessages();
    if (messages.length === 0) {
      const emptyMessage = 'Nothing to compact: conversation is empty.';
      if (triggeredByTokenLimit) {
        this._post({ type: 'info', message: emptyMessage });
      }
      return JSON.stringify({ success: false, message: emptyMessage });
    }

    if (!triggeredByTokenLimit) {
      this._post({ type: 'info', message: '🗜️ Compacting conversation history…' });
    } else {
      this._post({ type: 'info', message: '⚡ Context window nearly full — compacting conversation history…' });
    }

    const abortController = new AbortController();
    try {
      const apiConfig = this._getApiConfig();

      const historyText = messages
        .filter(m => m.role !== 'tool' || !!m.content)
        .map(m => {
          const roleLabel =
            m.role === 'user' ? 'User' :
            m.role === 'assistant' ? 'Assistant' :
            m.role === 'tool' ? 'Tool result' : 'System';
          const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return `[${roleLabel}]\n${body}`;
        })
        .join('\n\n---\n\n');

      const summarizePrompt =
        `You are a conversation summarizer. Below is the full history of a coding-assistant session.\n` +
        `Your job is to write a CONCISE but COMPLETE summary that will replace the history.\n\n` +
        `Rules:\n` +
        `- Keep: all files created/modified (with key changes), decisions made, goals, current task state, and any open questions.\n` +
        `- Omit: verbose tool output, repetitive reasoning, step-by-step narration already reflected in outcomes.\n` +
        `- Write in third-person present tense ("The user is building…", "The assistant has modified…").\n` +
        `- End with a short "## Current State" section describing what was happening right before this summary.\n\n` +
        `=== CONVERSATION HISTORY ===\n${historyText}\n=== END ===\n\n` +
        `Write the summary now:`;

      const summaryResponse = await sendChatMessage(
        [{ role: 'user', content: summarizePrompt }],
        apiConfig,
        undefined,
        abortController.signal
      );

      const summary = summaryResponse.content?.trim() ?? '(summary unavailable)';

      const summaryMessage: ChatMessage = {
        role: 'assistant',
        content:
          `📋 **[Conversation history compacted]**\n\n${summary}`,
      };

      this._session.setCurrentMessages([summaryMessage]);

      this._post({ type: 'clearMessages' });
      this._post({ type: 'addMessage', message: { role: 'assistant', content: summaryMessage.content! } });

      if (!triggeredByTokenLimit) {
        this._post({ type: 'info', message: '✅ History compacted. Continuing with summary as context.' });
      }

      return JSON.stringify({
        success: true,
        message: 'Conversation history compacted successfully.',
        summary: summaryMessage.content,
      });
    } catch (error: any) {
      if (error.name === 'AbortError') {
        const abortMessage = 'Compact cancelled.';
        this._post({ type: 'info', message: abortMessage });
        return JSON.stringify({ success: false, message: abortMessage });
      }
      const errorMessage = `Failed to compact history: ${error.message}`;
      this._post({ type: 'error', message: errorMessage });
      return JSON.stringify({ success: false, message: errorMessage });
    }
  }

  /**
   * Replays persisted messages to the webview (bubbles + tool cards).
   */
  replaySessionToWebview(post: (msg: any) => void): void {
    const messages = this._session.getCurrentMessages();
    let i = 0;
    while (i < messages.length) {
      const m = messages[i];
      if (m.role === 'user' && m.content) {
        post({ type: 'addMessage', message: { role: 'user', content: m.content } });
        i++;
        continue;
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        if (m.content) {
          post({ type: 'addMessage', message: { role: 'assistant', content: m.content } });
        }
        i++;
        for (const tc of m.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            /* keep empty */
          }
          post({ type: 'toolCall', name: tc.function.name, args });
          const tm = messages[i];
          if (tm?.role === 'tool' && tm.tool_call_id === tc.id) {
            post({ type: 'toolResult', name: tc.function.name, result: tm.content ?? '{}' });
            i++;
          } else {
            post({
              type: 'toolResult',
              name: tc.function.name,
              result: JSON.stringify({ error: 'Missing tool result in saved session' }),
            });
          }
        }
        continue;
      }
      if (m.role === 'assistant' && m.content) {
        post({ type: 'addMessage', message: { role: 'assistant', content: m.content } });
        i++;
        continue;
      }
      if (m.role === 'tool') {
        i++;
        continue;
      }
      i++;
    }
  }

  /** Drop the user message matching `userContent` and everything after (e.g. Git rollback). */
  truncateBeforeUserMessage(userContent: string): void {
    const msgs = this._session.getCurrentMessages();
    const cutIndex = msgs.findIndex(
      u => u.role === 'user' && (typeof u.content === 'string' ? u.content : '') === userContent
    );
    if (cutIndex !== -1) {
      this._session.setCurrentMessages(msgs.slice(0, cutIndex));
    }
  }
}
