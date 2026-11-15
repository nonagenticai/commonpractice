// @vitest-environment jsdom
//
// src/lib/components/file-upload.drop-guard.render.test.ts — the drag-and-drop path refuses a file
// this uploader cannot read, in the READER'S language, before any round trip.
//
// ⛔ THE DEFECT. `FileUpload.svelte`'s only filter was `accept=` on the hidden <input>, and a browser
// applies `accept` to the FILE PICKER ONLY — a drop never consults it. `onDrop` read
// `e.dataTransfer.files[0]` and handed it straight to `onfile`. Downstream,
// `backend/src/routes/datasets.ts` closed `sourceTypeFromName`'s null with `?? 'csv'`, so a dropped
// `report.pdf` was decoded as UTF-8, `%PDF-1.7` became the header row, and /datasets showed a
// dataset that looked successfully imported. Two guards missing in a row, one gesture.
//
// ⛔ THE ASSERTION THAT INVERTS ON A REVERT is `expect(onfile).not.toHaveBeenCalled()` — that is
// exactly what the un-fixed `take()` did. The Dutch-sentence assertions are the second half: a
// refusal the reader cannot read is the same silence with extra steps.
//
// ⚠️ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED — the real compiled paraglide functions, driven off
// the real locale rune, the same lever `dataset-preview.coltype-dutch.render.test.ts` uses. The
// runtime's own locale is English, so a Dutch word cannot appear here by accident.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { locale } from '$lib/stores/locale.svelte';
import FileUpload from './FileUpload.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	// Assigned directly, never `locale.set()` — that fires an authFetch PATCH the fail-loud fetch
	// stub in lib/test/setup.ts would name.
	locale.current = initialLocale;
});

/**
 * Mount the uploader and DROP a file on it.
 *
 * ⚠️ A HAND-BUILT `drop` EVENT, BECAUSE jsdom SHIPS NO USABLE `DataTransfer`. `new DragEvent('drop')`
 * there carries `dataTransfer: null`, so a real constructor would exercise nothing. The shape below
 * is exactly the two fields `onDrop` reads (`dataTransfer.files[0]`) plus the cancelability
 * `preventDefault()` needs — anything more would be inventing a browser this test cannot check.
 */
function drop(file: File) {
	const onfile = vi.fn();
	const onreject = vi.fn();
	app = mount(FileUpload, { target: host, props: { onfile, onreject } });
	flushSync();
	const zone = host.querySelector('.upload');
	// ⛔ THE POSITIVE ANCHOR. A component that failed to mount renders nothing, and every
	// "onfile was not called" assertion below would pass against an empty DOM.
	expect(zone, 'the uploader never rendered — the drop reached nothing').not.toBeNull();

	const ev = new Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(ev, 'dataTransfer', { value: { files: [file] } });
	zone!.dispatchEvent(ev);
	flushSync();
	return { onfile, onreject };
}

/** U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL ISOLATE — the pair the component wraps a
 *  reader-supplied name in. Spelled by code point so this file carries no invisible characters. */
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);

describe('the drop path refuses what `accept=` only ever filtered in the picker', () => {
	it('⛔ THE DROPPED PDF: refused in Dutch, and never handed to the uploader', () => {
		locale.current = 'nl';
		const { onfile, onreject } = drop(
			new File(['%PDF-1.7\n1 0 obj\n'], 'report.pdf', { type: 'application/pdf' })
		);

		// ⛔ THE INVERTING ASSERTION — the pre-fix `take()` called this.
		expect(onfile).not.toHaveBeenCalled();
		expect(onreject).toHaveBeenCalledTimes(1);

		const message = onreject.mock.calls[0]![0] as string;
		// The reader is told WHICH extension was refused and WHAT to send instead.
		expect(message).toContain(`${FSI}.pdf${PDI}`);
		expect(message).toContain('CSV');
		// Dutch, not the English fallback. `importeren` is in the nl catalog entry and in no other.
		expect(message).toContain('importeren');
		expect(message).not.toContain('cannot import');
	});

	it('a file with NO extension is refused by its own name, not guessed at', () => {
		locale.current = 'nl';
		const { onfile, onreject } = drop(new File(['a,b\n1,2\n'], 'export'));

		expect(onfile).not.toHaveBeenCalled();
		const message = onreject.mock.calls[0]![0] as string;
		expect(message).toContain(`${FSI}export${PDI}`);
		expect(message).toContain('bestandsextensie');
		// ⚠️ The two arms are DIFFERENT sentences — a single generic refusal would pass the assertion
		// above and tell the reader to convert a file that only needs renaming.
		expect(message).not.toContain('importeren');
	});

	it('⚠️ THE WORKING PATHS STILL WORK — a .csv and a .txt reach `onfile` untouched', () => {
		locale.current = 'nl';
		for (const name of ['cities.csv', 'notes.txt', 'BOOK.XLSX']) {
			const { onfile, onreject } = drop(new File(['a,b\n1,2\n'], name));
			expect(onreject, `${name} was refused`).not.toHaveBeenCalled();
			expect(onfile, `${name} never reached the uploader`).toHaveBeenCalledTimes(1);
			expect((onfile.mock.calls[0]![0] as File).name).toBe(name);
			unmount(app!);
			app = undefined;
		}
	});

	it('the refusal follows the reader’s locale rather than hard-coding one language', () => {
		locale.current = 'en';
		const { onreject } = drop(new File([''], 'report.pdf'));
		const message = onreject.mock.calls[0]![0] as string;
		expect(message).toContain('cannot import');
		expect(message).not.toContain('importeren');
	});
});
