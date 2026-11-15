// src/lib/services/sse.ts — consume the run trace SSE stream. We use
// fetch + ReadableStream (NOT EventSource) so authFetch's Keycloak Bearer is
// sent — EventSource cannot attach an Authorization header. Parses the
// `id:`/`event:`/`data:` framing, tracks Last-Event-ID, and auto-reconnects
// (resuming from lastEventId) if the connection drops before the run ends.
import { authFetch } from '$lib/api/auth-fetch';
import * as m from '$lib/paraglide/messages';
import { bidiIsolate } from '$lib/i18n/graph-issue-label';
import type { TraceEvent } from '$lib/types/trace';

export interface StreamHandlers {
  onEvent: (ev: TraceEvent) => void;
  onError?: (err: unknown) => void;
  /** Fired once when the server signals the stream is complete. */
  onEnd?: () => void;
}

export interface StreamControl {
  close: () => void;
}

export interface SseBlock {
  id?: number;
  event?: string;
  data?: string;
}

/** Parse one SSE block (the text between `\n\n` delimiters) into its fields.
 *  Exported so the agent-chat client can reuse the exact framing parser. */
export function parseBlock(raw: string): SseBlock | null {
  const block: SseBlock = {};
  let sawField = false;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // blank or comment (heartbeat)
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') {
      block.id = Number(value);
      sawField = true;
    } else if (field === 'event') {
      block.event = value;
      sawField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    }
  }
  if (dataLines.length) block.data = dataLines.join('\n');
  return sawField ? block : null;
}

export function streamRun(runId: string, handlers: StreamHandlers): StreamControl {
  const ac = new AbortController();
  let closed = false;
  let lastEventId = 0;
  let reconnects = 0;
  const MAX_RECONNECTS = 8;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      ac.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });

  const terminalError = (err: unknown) => {
    if (closed) return;
    closed = true;
    handlers.onError?.(err);
  };

  async function connect(): Promise<void> {
    while (!closed) {
      try {
        const qs = lastEventId ? `?lastEventId=${lastEventId}` : '';
        const res = await authFetch(`/api/runs/${encodeURIComponent(runId)}/stream${qs}`, {
          headers: { Accept: 'text/event-stream' },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text();
          // ⛔ THE DEFECT WAS THE SUFFIX, AND THE FRAME AROUND IT WAS NO BETTER. This built
          // `` `Run stream failed (${res.status})` `` and then APPENDED the hardcoded English
          // `` ` (request ${id})` `` — two sentences this module authors itself, on a tenant-facing
          // /build failure, in all eight locales. `handlers.onError` receives an `Error` whose
          // `message` is rendered straight to the reader, so nothing downstream localizes it.
          //
          // ⛔ THE REQUEST ID IS KEPT, NOT DROPPED, AND THAT WAS THE REAL CHOICE HERE. Dropping the
          // suffix would have "fixed" the English in one line. But the id is the ONLY actionable
          // thing on the screen: it is what a tenant quotes to support and what correlates this
          // failure to a backend log line. A refusal the reader cannot act on is its own defect —
          // localizing a message while deleting the one fact that makes it useful trades one for
          // the other. So it is localized WITH the id, in the house frame idiom
          // (`connection-test-label.ts`: localize the FRAME, interpolate the technical string).
          //
          // ⚠️ BOTH INTERPOLATED VALUES ARE BIDI-ISOLATED. `detail` is a backend-supplied sentence
          // and `id` is a latin-script token; without isolation, an Arabic or Hebrew frame reorders
          // them into nonsense. Same reasoning as every other `iso()` site — see `graph-issue-label.ts`.
          let detail = `HTTP ${res.status}`;
          let requestId: string | undefined;
          try {
            const body = JSON.parse(text) as { message?: string; error?: string; requestId?: string };
            detail = body.message ?? body.error ?? detail;
            requestId = body.requestId;
          } catch {
            // Keep the status-bearing fallback for an ingress/proxy HTML response.
          }
          const message = requestId
            ? m.run_stream_failed_request({
                detail: bidiIsolate(detail),
                id: bidiIsolate(requestId),
              })
            : m.run_stream_failed({ detail: bidiIsolate(detail) });
          terminalError(new Error(message));
          return;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        let ended = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let delimiter: RegExpExecArray | null;
          while ((delimiter = /\r?\n\r?\n/.exec(buf)) !== null) {
            const raw = buf.slice(0, delimiter.index);
            buf = buf.slice(delimiter.index + delimiter[0].length);
            const block = parseBlock(raw);
            if (!block) continue;
            if (typeof block.id === 'number' && !Number.isNaN(block.id)) lastEventId = block.id;
            if (block.event === 'end') {
              ended = true;
              break;
            }
            if (block.data) {
              try {
                handlers.onEvent(JSON.parse(block.data) as TraceEvent);
                reconnects = 0;
              } catch {
                /* ignore a malformed frame */
              }
            }
          }
          if (ended) break;
        }
        if (ended || closed) {
          closed = true;
          handlers.onEnd?.();
          return;
        }
        // Stream dropped without an explicit end → reconnect from lastEventId.
      } catch (err) {
        if (closed || ac.signal.aborted) return;
        reconnects++;
        if (reconnects > MAX_RECONNECTS) {
          terminalError(err);
          return;
        }
        await wait(Math.min(15_000, 500 * 2 ** (reconnects - 1)));
        continue;
      }
      reconnects++;
      if (reconnects > MAX_RECONNECTS) {
        terminalError(new Error('Run stream disconnected repeatedly. The run is still safe to reopen.'));
        return;
      }
      await wait(Math.min(15_000, 500 * 2 ** (reconnects - 1)));
    }
  }

  void connect();
  return {
    close() {
      closed = true;
      ac.abort();
    },
  };
}
