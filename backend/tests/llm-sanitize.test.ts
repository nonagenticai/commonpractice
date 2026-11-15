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
