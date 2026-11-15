// src/lib/stores/run-trace.svelte.ts — reactive state for one live test run.
// Ingests SSE TraceEvents into an append-only event log (for the console) + a
// per-node status map (for the canvas node badges). Mirrors BuilderStore's
// $state.raw + reassign idiom so Svelte re-renders on each event.
import type { TraceEvent, RunStatus, CostDelta } from '$lib/types/trace';
import { zeroCost } from '$lib/types/trace';

export type NodeRunStatus = 'running' | 'ok' | 'error' | 'skipped';

export interface NodeRunInfo {
  status: NodeRunStatus;
  durationMs?: number;
  cost?: CostDelta;
  error?: string;
}

export class RunTraceStore {
  events = $state.raw<TraceEvent[]>([]);
  byNode = $state.raw<Record<string, NodeRunInfo>>({});
  status = $state<'idle' | RunStatus>('idle');
  totals = $state<CostDelta>(zeroCost());
  runId = $state<string | null>(null);

  /** Clear for a fresh run (status → running). */
  reset(runId: string | null): void {
    this.events = [];
    this.byNode = {};
    this.status = 'running';
    this.totals = zeroCost();
    this.runId = runId;
  }

  /** Clear back to idle (e.g. switching flows). */
  clear(): void {
    this.events = [];
    this.byNode = {};
    this.status = 'idle';
    this.totals = zeroCost();
    this.runId = null;
  }

  ingest(ev: TraceEvent): void {
    this.events = [...this.events, ev];
    switch (ev.type) {
      case 'node_start':
        this.byNode = { ...this.byNode, [ev.nodeId]: { status: 'running' } };
        break;
      case 'node_success':
        this.byNode = {
          ...this.byNode,
          [ev.nodeId]: { status: 'ok', durationMs: ev.durationMs, cost: ev.cost },
        };
        break;
      case 'node_error':
        this.byNode = {
          ...this.byNode,
          [ev.nodeId]: { status: 'error', durationMs: ev.durationMs, error: ev.error },
        };
        break;
      case 'node_skipped':
        this.byNode = { ...this.byNode, [ev.nodeId]: { status: 'skipped' } };
        break;
      case 'run_complete':
        this.status = ev.status;
        this.totals = ev.totals ?? zeroCost();
        break;
    }
  }
}
