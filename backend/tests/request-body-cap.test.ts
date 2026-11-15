// request-body-cap.test.ts — the cap on `readJson` / `readJsonOptional`.
//
// ⛔ THE CASE THIS EXISTS FOR IS THE ONE WITHOUT A content-length. A body limit that only reads the
// header is the most commonly written version of this bug and it is bypassed by any chunked
// request — the header is a client-supplied claim, and it can simply be absent. So the streaming
// test below sends a body with NO content-length and asserts it is still refused; without that
// test, a header-only implementation passes everything here and enforces nothing in production.
import { test, expect } from 'bun:test';
import { readJson, readJsonOptional, HttpError } from '../src/utils/http';

const CAP = 1_048_576;

function jsonReq(body: string, headers: Record<string, string> = {}) {
  return new Request('http://t/x', { method: 'POST', body, headers });
}

/** A body of `bytes` length delivered as a stream, with NO content-length header. */
function streamedReq(bytes: number) {
  const chunk = new TextEncoder().encode('a'.repeat(64 * 1024));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
  return new Request('http://t/x', {
    method: 'POST',
    body: stream,
    // Required by the fetch spec for a streaming request body; Bun's types accept it.
    duplex: 'half',
  });
}

test('an ordinary body still parses', async () => {
  expect(await readJson(jsonReq(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
});

test('a body at ~7KB — the largest JSON this service actually stores — is accepted', async () => {
  // Measured in production: `chat_messages.content` tops out at 6,963 bytes. The cap must be
  // nowhere near real traffic, so this asserts the headroom rather than just the refusal.
  const big = { text: 'x'.repeat(7000) };
  expect(await readJson(jsonReq(JSON.stringify(big)))).toEqual(big);
});

test('an oversized body is refused by declared content-length, before a byte is read', async () => {
  const req = jsonReq('{}', { 'content-length': String(CAP + 1) });
  let err: unknown;
  try {
    await readJson(req);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(413);
  expect((err as HttpError).code).toBe('request_body_too_large');
});

test('an oversized STREAMED body with no content-length is still refused', async () => {
  // ⛔ THE NON-VACUITY. A header-only implementation passes every other test in this file and fails
  // exactly this one.
  let err: unknown;
  try {
    await readJson(streamedReq(CAP + 128 * 1024));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(413);

  // Positive control: an UNDER-cap stream of the same shape is read fine, so the refusal above is
  // the size and not the streaming.
  const ok = await readJson(
    new Request('http://t/x', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"a":1}'));
          c.close();
        },
      }),
      duplex: 'half',
    }),
  );
  expect(ok).toEqual({ a: 1 });
});

test('malformed JSON is still a 400 invalid_json, not a 413', async () => {
  let err: unknown;
  try {
    await readJson(jsonReq('{nope'));
  } catch (e) {
    err = e;
  }
  expect((err as HttpError).status).toBe(400);
  expect((err as HttpError).code).toBe('invalid_json');
});

test('readJsonOptional keeps its empty-body-is-{} contract under the cap', async () => {
  expect(await readJsonOptional(jsonReq(''))).toEqual({});
  expect(await readJsonOptional(jsonReq('  '))).toEqual({});
  expect(await readJsonOptional(jsonReq('{"a":2}'))).toEqual({ a: 2 });

  // And still rejects malformed rather than swallowing it — the anti-pattern its docstring names.
  let err: unknown;
  try {
    await readJsonOptional(jsonReq('{nope'));
  } catch (e) {
    err = e;
  }
  expect((err as HttpError).code).toBe('invalid_json');
});
