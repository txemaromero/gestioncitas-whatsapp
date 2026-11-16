import type { Logger } from '../logger';

/**
 * Tracks fire-and-forget work (webhook processing after the immediate 200, Chatwoot mirror),
 * so errors are logged and tests / graceful shutdown can wait until everything settled.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly logger: Logger) {}

  run(label: string, task: () => Promise<unknown>): void {
    const promise = Promise.resolve()
      .then(task)
      .then(
        () => undefined,
        (error: unknown) => {
          this.logger.error({ err: error instanceof Error ? error.message : String(error), task: label }, 'background task failed');
        },
      )
      .finally(() => {
        this.pending.delete(promise);
      });
    this.pending.add(promise);
  }

  /** Resolves when every task (including tasks scheduled meanwhile) has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  get size(): number {
    return this.pending.size;
  }
}
