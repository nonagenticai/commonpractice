// src/lib/types/sandboxes.ts — 1:1 with the backend sandbox routes
// (backend/src/routes/sandboxes.ts). cost/usage are derived live; cpu/mem live
// values are intentionally absent (best-effort/Linux-only) — the UI shows the cap.
export type SandboxStatus = 'running' | 'idle' | 'suspended' | 'error';

export interface SandboxRow {
	id: string;
	slug: string;
	owner: { name: string; initials: string };
	project: string | null;
	status: SandboxStatus;
	region: string;
	memCapMb: number;
	startedAt: string | null;
	llmCallsToday: number;
	costTodayUsd: number;
}

export interface SandboxCounts {
	all: number;
	running: number;
	idle: number;
	suspended: number;
	error: number;
}

export interface SandboxList {
	items: SandboxRow[];
	total: number;
	page: number;
	pageSize: number;
	counts: SandboxCounts;
}

export interface SandboxRun {
	id: string;
	flowName: string;
	status: string;
	totalMs: number | null;
	costUsd: number;
	llmCalls: number;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface SandboxDetail extends SandboxRow {
	label: string;
	createdAt: string;
	recentRuns: SandboxRun[];
}
