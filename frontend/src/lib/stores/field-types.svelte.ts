// src/lib/stores/field-types.svelte.ts — whether the builder shows port type chips (Text / Yes-no /
// JSON …). Hidden by default: a business reader needs the port's name, not its data type.
//
// Two facts: `preference` is the reader's own switch in the toolbar ⋯ menu (persisted per browser),
// and `allowed` is whether the current role may use that switch at all (developer and above; the
// /build page sets it from `auth.isDeveloper`). The chips render only when BOTH hold, so a member on
// a browser a developer once used still sees the clean canvas.

export const FIELD_TYPES_STORAGE_KEY = 'cp.build.fieldTypes';

export type FieldTypesStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): FieldTypesStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export function readFieldTypesPreference(storage: FieldTypesStorage | null): boolean {
	if (!storage) return false;
	try {
		return storage.getItem(FIELD_TYPES_STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

export function writeFieldTypesPreference(storage: FieldTypesStorage | null, on: boolean): void {
	if (!storage) return;
	try {
		storage.setItem(FIELD_TYPES_STORAGE_KEY, on ? '1' : '0');
	} catch {
		// Not remembered across reloads; the switch still works for this page view.
	}
}

export class FieldTypesStore {
	preference = $state(false);
	allowed = $state(false);
	readonly #storage: FieldTypesStorage | null;

	constructor(storage: FieldTypesStorage | null = defaultStorage()) {
		this.#storage = storage;
		this.preference = readFieldTypesPreference(storage);
	}

	/** Whether the type chips render right now. */
	get visible(): boolean {
		return this.allowed && this.preference;
	}

	toggle(): void {
		if (!this.allowed) return;
		this.preference = !this.preference;
		writeFieldTypesPreference(this.#storage, this.preference);
	}
}

export const fieldTypes = new FieldTypesStore();
