import type { AgentRun, AgentUiResponse } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  pendingUiRequests: Set<string>;
  onUiSettled?: () => void;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();

  register(chatId: string, run: AgentRun): RunHandle {
    const handle: RunHandle = { run, interrupted: false, pendingUiRequests: new Set() };
    this.handles.set(chatId, handle);
    return handle;
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    h.interrupted = true;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  respondToUi(chatId: string, requestId: string, response: AgentUiResponse): boolean {
    const h = this.handles.get(chatId);
    const ok = h?.run.respondToUi?.(requestId, response) === true;
    if (ok) h?.pendingUiRequests.delete(requestId);
    if (ok) h?.onUiSettled?.();
    return ok;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
}
