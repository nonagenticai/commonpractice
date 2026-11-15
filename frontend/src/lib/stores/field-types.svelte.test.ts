// src/lib/stores/field-types.svelte.test.ts — port type chips: off by default, developer-gated.
import { describe, it, expect } from 'vitest';
import { FieldTypesStore, FIELD_TYPES_STORAGE_KEY, type FieldTypesStorage } from './field-types.svelte';

function memory(initial: Record<string, string> = {}): FieldTypesStorage & { data: Record<string, string> } {
	const data = { ...initial };
	return {
		data,
		getItem: (k) => (k in data ? data[k] : null),
		setItem: (k, v) => {
			data[k] = v;
		}
	};
}

describe('FieldTypesStore', () => {
	it('is hidden by default, even for a role that may switch it on', () => {
		const s = new FieldTypesStore(memory());
		s.allowed = true;
		expect(s.visible).toBe(false);
	});

	it('a developer switches it on, and the choice is remembered', () => {
		const storage = memory();
		const s = new FieldTypesStore(storage);
		s.allowed = true;
		s.toggle();
		expect(s.visible).toBe(true);
		expect(storage.data[FIELD_TYPES_STORAGE_KEY]).toBe('1');
		expect(new FieldTypesStore(storage).preference).toBe(true);
	});

	it('⛔ a saved preference does not show the chips to a role that may not switch them', () => {
		const s = new FieldTypesStore(memory({ [FIELD_TYPES_STORAGE_KEY]: '1' }));
		expect(s.preference).toBe(true);
		expect(s.visible).toBe(false);
		s.toggle();
		expect(s.preference, 'a member flipped the switch').toBe(true);
	});

	it('survives storage that throws', () => {
		const broken: FieldTypesStorage = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			}
		};
		const s = new FieldTypesStore(broken);
		s.allowed = true;
		expect(s.visible).toBe(false);
		s.toggle();
		expect(s.visible).toBe(true);
	});
});
