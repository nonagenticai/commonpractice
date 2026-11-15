// src/lib/types/templates.ts — mirrors the Block Template API (backend templates-service.ts).
// Templates are STARTER SCAFFOLDS surfaced in the block editor's "From template" create mode:
// picking one pre-fills a new block's descriptor + source skeleton + docs.
import type { BlockCategory, BlockDescriptor } from './blocks';

export interface TemplateStep {
	label: string;
	detail: string;
}

export interface TemplateSummary {
	id: string;
	category: BlockCategory;
	domain: string | null;
	name: string;
	label: string;
	description: string;
	tags: string[];
	tenantOwned: boolean;
}

export interface TemplateDetail extends TemplateSummary {
	descriptor: BlockDescriptor;
	source_ts: string;
	docs_md: string;
	preconditions: string[];
	postconditions: string[];
	steps: TemplateStep[];
}

export interface TemplateListResult {
	templates: TemplateSummary[];
	/** Facets for the editor's filters (scoped to the requested category when given). */
	categories: BlockCategory[];
	domains: string[];
	tags: string[];
}
