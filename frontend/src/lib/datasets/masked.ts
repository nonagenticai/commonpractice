// src/lib/datasets/masked.ts — how a value the reader may not see is drawn (W8/P7). The backend
// blanks it (backend/src/datasets/member-view.ts); the browser shows this in its place, with the
// `dataset_preview_masked` tooltip ("Hidden personal data").
export const MASKED_CELL = '•••';
