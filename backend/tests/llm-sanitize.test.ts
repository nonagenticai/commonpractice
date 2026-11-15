// tests/llm-sanitize.test.ts — stripping leaked harmony/CoT control tokens from
// OpenAI-compatible (inference-router local-llm) message content.
import { test, expect } from 'bun:test';
import { stripReasoningTokens, StreamSanitizer } from '../src/ai/llm/sanitize';

// Feed `chunks` through the streaming sanitizer and return the concatenation of
// every emitted delta (what the browser bubble would show mid-stream).
function streamAll(chunks: string[]): string {
  const s = new StreamSanitizer();
  let out = '';
  for (const c of chunks) out += s.push(c);
  out += s.flush();
  return out;
}

test('passes clean text through unchanged', () => {
  expect(stripReasoningTokens('I added an ai-summarize block.')).toBe(
    'I added an ai-summarize block.',
  );
  expect(stripReasoningTokens('')).toBe('');
});

test('strips the malformed leaked channel header seen live', () => {
  // exactly the form observed on the live drive (2026-06-07)
  const leaked =
    "<|channel>thought <channel|>I couldn't find a specific summarize block.";
  expect(stripReasoningTokens(leaked)).toBe(
    "I couldn't find a specific summarize block.",
  );
});

test('keeps only the final channel when a canonical harmony structure is present', () => {
  const harmony =
    '<|channel|>analysis<|message|>The user wants a summary step.<|end|>' +
    '<|channel|>final<|message|>Done — I added ai-summarize to your flow.';
  expect(stripReasoningTokens(harmony)).toBe(
    'Done — I added ai-summarize to your flow.',
  );
});

test('removes residual special tokens but keeps real content', () => {
  expect(stripReasoningTokens('Hello<|end|> world')).toBe('Hello world');
});

// ---- reassembly: a single strip pass is not enough ----
// Removing one token can ASSEMBLE the next one. A single pass leaves the
// reassembled token in the output; the strip repeats until the string is stable.

test('removes a special token reassembled by removing an inner token', () => {
  // One pass removes the INNER <|end|> and leaves an outer <|end|> behind.
  expect(stripReasoningTokens('Hello<|en<|end|>d|> world')).toBe('Hello world');
});

test('removes a channel header assembled after the pass walked over it', () => {
  // The header is split by a nested token, so it only becomes matchable after
  // that token is gone — i.e. after the pass has already moved past it.
  expect(
    stripReasoningTokens('<|chan<|end|>nel|>thought<|message|>secret plan'),
  ).toBe('secret plan');
});

test('strips a fully bar-delimited marker that looks like a tag', () => {
  // Reassembly produces `<|script|>`; it is a marker (bar-delimited) and goes.
  expect(stripReasoningTokens('<|scr<|end|>ipt|>alert(1)')).toBe('alert(1)');
});

test('leaves plain HTML tags alone — a marker requires a bar', () => {
  // The model may legitimately show HTML in a code sample. This strip owns the
  // harmony MARKER grammar only; HTML safety is the renderer's job (chat
  // markdown goes through DOMPurify in frontend/src/lib/utils/markdown.ts).
  const sample = 'Use <script> and <div class="x"> in the page.';
  expect(stripReasoningTokens(sample)).toBe(sample);
});

// ---- StreamSanitizer (incremental, per-chunk) ----

test('streams clean text through unchanged across chunks', () => {
  expect(streamAll(['I added ', 'an ai-summarize ', 'block.'])).toBe(
    'I added an ai-summarize block.',
  );
});

test('strips the malformed leaked header, streams the real reply', () => {
  // the header arrives, then the reply — only the reply should reach the bubble
  expect(
    streamAll(['<|channel>thought <channel|>', "I couldn't find ", 'a summarize block.']),
  ).toBe("I couldn't find a summarize block.");
});

test('holds back a special token split across chunks', () => {
  // "<|end|>" arrives as "<|en" + "d|>" — never emit the half-token
  const out = streamAll(['Hello<|en', 'd|> world']);
  expect(out).toBe('Hello world');
  expect(out).not.toContain('<|en');
});

test('suppresses canonical analysis and emits only the final channel', () => {
  const out = streamAll([
    '<|channel|>analysis<|message|>',
    'The user wants a summary step.',
    '<|end|><|channel|>final<|message|>',
    'Done — added ai-summarize.',
  ]);
  expect(out).toBe('Done — added ai-summarize.');
  expect(out).not.toContain('user wants');
});

test('split channel header across chunks is still suppressed', () => {
  const out = streamAll([
    '<|chan',
    'nel|>analysis<|mess',
    'age|>secret reasoning<|end|>',
    '<|channel|>final<|message|>visible answer',
  ]);
  expect(out).toBe('visible answer');
  expect(out).not.toContain('secret');
});
