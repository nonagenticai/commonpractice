// src/lib/stores/agent-chat.tool-label.test.ts — the activity line names what the tool did.
// ⛔ Prod 2026-10-16: validate_flow showed as "doorzocht de catalogus (validate_flow)".
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	chat_tool_searched: (p: { tool: string }) => `searched:${p.tool}`,
	chat_tool_checked_flow: () => 'checked_flow',
	chat_tool_used: () => 'used'
}));
vi.mock('$lib/api/agent', () => ({}));
vi.mock('$lib/agent/driver', () => ({ describeEdit: () => '' }));
vi.mock('$lib/agent/cursor.svelte', () => ({ cursor: {} }));

import { toolActivityLabel } from './agent-chat.svelte';

describe('toolActivityLabel', () => {
	it('a flow check is not a catalogue search', () => {
		expect(toolActivityLabel('validate_flow')).toBe('checked_flow');
		expect(toolActivityLabel('run_flow')).toBe('checked_flow');
	});
	it('catalogue tools keep the catalogue label', () => {
		expect(toolActivityLabel('search_blocks')).toBe('searched:search_blocks');
	});
	it('anything else gets the neutral label', () => {
		expect(toolActivityLabel('get_ontology')).toBe('used');
	});
});
