/**
 * In-process wake-up signal: the webhook notifies it after storing events so the queue loops
 * start at once instead of waiting for their next poll. Waits always time out (polling is the
 * fallback for events stored by other instances and for retries), so a lost signal only adds
 * latency, never loses work.
 */
export class Signal {
  private readonly waiters = new Set<() => void>();
  private pending = false;

  notify(): void {
    if (this.waiters.size === 0) {
      this.pending = true;
      return;
    }
    for (const wake of [...this.waiters]) wake();
  }

  wait(timeoutMs: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      timer.unref();
      this.waiters.add(wake);
    });
  }
}
