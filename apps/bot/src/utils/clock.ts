/** Injectable clock so flows, jobs and tests can control "now". */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Fixed or manually advanced clock (tests and simulator). */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date | string): void {
    this.current = new Date(date).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** System clock shifted by an offset (simulator: "jump to tomorrow"). */
export class OffsetClock implements Clock {
  offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}
