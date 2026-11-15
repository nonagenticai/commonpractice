// src/lib/blocks/save-as-template.ts — Phase 5D (save as template): map the editor's
// save-as-template form into a CreateTemplateBody. Pure + framework-free so it is
// unit-tested directly. The PKO/PDDL formal structure (preconditions / postconditions /
// steps) is optional; blank rows are dropped so an untouched section saves as [].
import type { CreateTemplateBody } from '$lib/api/templates';
import type { BlockCategory, BlockDescriptor } from '$lib/types/blocks';

export interface TemplateFormState {
	label: string;
	name: string;
	domain: string;
	/** Comma-separated tag string from the form. */
	tags: string;
	preconditions: string[];
	postconditions: string[];
	steps: { label: string; detail: string }[];
}

export interface TemplateSource {
	category: BlockCategory;
	description: string;
	descriptor: BlockDescriptor;
	source_ts: string;
	docs_md: string;
}

/** Slugify a label into a fallback template name (lowercase, hyphenated). */
export function slugifyName(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Build the create-template body from the editor's form + the finished block design.
 * Trims and drops blank PKO/PDDL rows; a step is kept when it has a label OR a detail.
 */
export function toTemplateBody(form: TemplateFormState, source: TemplateSource): CreateTemplateBody {
	const label = form.label.trim();
	return {
		name: form.name.trim() || slugifyName(label),
		label,
		category: source.category,
		description: source.description,
		domain: form.domain.trim() || null,
		tags: form.tags
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean),
		descriptor: source.descriptor,
		source_ts: source.source_ts,
		docs_md: source.docs_md,
		preconditions: form.preconditions.map((c) => c.trim()).filter(Boolean),
		postconditions: form.postconditions.map((c) => c.trim()).filter(Boolean),
		steps: form.steps
			.map((s) => ({ label: s.label.trim(), detail: s.detail.trim() }))
			.filter((s) => s.label || s.detail)
	};
}
