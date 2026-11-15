// src/lib/types/flow-templates.ts — wire shapes of /api/flow-templates (backend routes/flow-templates.ts).

export type FlowTemplateScope = 'global' | 'tenant';

export interface FlowTemplateSummary {
	id: string;
	/** In the reader's language when a translation exists. */
	name: string;
	description: string;
	/** A starter's category key (`claims`, `requests`, `reporting`) or an organisation's own text. */
	category: string;
	/** `global` = a platform starter; `tenant` = saved by this organisation. */
	scope: FlowTemplateScope;
	blockCount: number;
	/** Every block the template uses resolves to a block this reader can use. */
	available: boolean;
	missingBlocks: string[];
	createdBy: string | null;
	createdAt: string;
	/** The reader may remove it (creator / tenant admin; a starter: platform admin). */
	canArchive: boolean;
}

/** `POST …/use` and `POST /api/solutions/:id/use-as-start`. */
export interface UseFlowTemplateResult {
	flowId: string;
	/** Slugs the new flow names but this reader cannot use — the builder flags those steps. */
	missingBlocks: string[];
}
