import type { Client, Db, Repos, Tenant } from '@clinicai/db';
import type { Logger } from '../logger';
import type { AIService } from '../services/aiServices';
import type { Clock } from '../utils/clock';
import type { IncomingMessage, OutgoingMessage } from './types';

export const FLOW_NAMES = [
  'main',
  'register',
  'intention',
  'cita',
  'employee',
  'confirmation',
  'reminderResponse',
  'faq',
  'manage',
] as const;
export type FlowName = (typeof FLOW_NAMES)[number];

export interface FlowState {
  flow: FlowName;
  step: string;
  data: Record<string, unknown>;
  errorCount: number;
}

/** Injected dependencies: flows never do I/O on their own. */
export interface FlowDeps {
  db: Db;
  repos: Repos;
  ai: AIService;
  clock: Clock;
  logger: Logger;
}

export interface FlowContext {
  tenant: Tenant;
  phone: string;
  /** Registered client of this tenant for the phone, if any. */
  client: Client | null;
  /** Current state of the flow being executed (null when the flow starts). */
  state: FlowState | null;
  deps: FlowDeps;
  now: Date;
}

export type FlowNext = { flow: FlowName; step: string; data?: Record<string, unknown> } | 'end';

export interface FlowResult {
  replies: OutgoingMessage[];
  next: FlowNext;
  /** The message was not understood: counts towards the 3-failures limit of the flow. */
  error?: boolean;
  /** An appointment was cancelled or moved: offer the freed slot to the waiting list (F17). */
  slotFreed?: boolean;
}

export interface Flow {
  readonly name: FlowName;
  handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult>;
}

export const text = (value: string): OutgoingMessage => ({ type: 'text', text: value });

/** State that keeps the conversation "open" without a guided flow: next message is classified. */
export const IDLE: FlowNext = { flow: 'intention', step: 'await' };

/** Typed accessors for the JSON state bag. */
export function getString(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function getNumber(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = data?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getArray<T>(data: Record<string, unknown> | undefined, key: string): T[] {
  const value = data?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}
