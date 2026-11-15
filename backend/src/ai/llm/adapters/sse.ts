// src/ai/llm/adapters/sse.ts — a tiny SSE `data:` line reader shared by the
// streaming adapters (openai.ts + anthropic.ts). Reads a fetch Response body as a
// byte stream, buffers across chunk boundaries, and yields each event's `data:`
// payload (the part after the prefix). `event:` and comment/blank lines are
// skipped — both OpenAI and Anthropic embed their event type INSIDE the data JSON
// (`choices`/`delta` for OpenAI, a `type` field for Anthropic), so the adapters
// parse the payload directly. OpenAI signals end with the literal `[DONE]`.
//
// Test seam: the adapters take an injectable fetchImpl, so a test feeds a
// `new Response(recordedSseString)` and this reader replays it with zero network.
export async function* sseData(res: Response): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const drain = function* (final: boolean): Generator<string> {
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
    // On the final flush, the remaining buffer may be a last data line with no \n.
    if (final && buf.startsWith('data:')) {
      const tail = buf.slice(5).trim();
      buf = '';
      if (tail) yield tail;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    yield* drain(false);
  }
  buf += decoder.decode();
  yield* drain(true);
}
