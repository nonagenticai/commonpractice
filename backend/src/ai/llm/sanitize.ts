// src/ai/llm/sanitize.ts — strip chain-of-thought / "harmony" control tokens that
// some OpenAI-compatible models (gpt-oss-style, served via the inference-router as
// `local-llm`) leak into the message `content`. Seen live as
//   "<|channel>thought <channel|>the real reply"
// and in the canonical form
//   "<|channel|>analysis<|message|>…<|end|><|channel|>final<|message|>the answer".
// We return only the user-facing text: prefer the `final` channel when present,
// otherwise drop the channel headers + any residual special tokens. These tokens
// are never legitimate assistant content, so stripping is safe.

// Any harmony-ish special token: <|channel|>, <|message|>, <|end|>, plus the
// malformed half-delimited variants the model leaked (<|channel>, <channel|>).
const SPECIAL_TOKEN = /<\|?[a-z_]+\|?>/gi;
const CHANNEL_HEADER =
  /<\|?channel\|?>\s*(?:analysis|thought|commentary|final)\s*(?:<\|?[a-z_]+\|?>)?/gi;
const LEADING_CHANNEL_WORD = /^\s*(?:analysis|thought|commentary|final)\b[ \t:]*/i;

export function stripReasoningTokens(text: string): string {
  if (!text || !text.includes('<')) return text;

  // If a proper "final" channel is present, keep only its message.
  const finalMatch = text.match(
    /<\|?channel\|?>\s*final\s*<\|?message\|?>([\s\S]*?)(?:<\|?(?:end|return|channel)\|?>|$)/i,
  );
  let out = finalMatch?.[1] ?? text;

  // Repeat the WHOLE strip until a full pass changes nothing. One pass is not
  // enough: removing a token can REASSEMBLE the next one. `<|chan<|end|>nel|>`
  // loses the inner `<|end|>` and becomes `<|channel|>` — a token that pass has
  // already stepped over — and `<|scr<|end|>ipt|>` becomes `<|script|>` the same
  // way. The channel/leading-word rules have the same problem in reverse: a
  // header split by a nested token only becomes matchable after that token is
  // gone. Termination is guaranteed: every pattern matches at least one
  // character and each replacement is empty, so any changing pass strictly
  // shortens the string.
  let previous: string;
  do {
    previous = out;
    out = out.replace(CHANNEL_HEADER, '');
    out = out.replace(SPECIAL_TOKEN, '');
    out = out.replace(LEADING_CHANNEL_WORD, '');
  } while (out !== previous);

  return out.trim();
}

// A canonical NON-final channel header (analysis/thought/commentary) in the
// proper double-bar harmony form, paired with a <|message|> marker — i.e. the
// model is mid-reasoning and the user-facing answer will arrive in a later
// `final` channel. (The MALFORMED leaked form "<|channel>thought <channel|>reply"
// has no <|message|> and the real reply right after the header, so it is NOT
// suppressed — its header is stripped and the reply streams.)
const NONFINAL_OPEN = /<\|?channel\|?>\s*(?:analysis|thought|commentary)\b/i;
const FINAL_OPEN = /<\|?channel\|?>\s*final\b/i;
const MESSAGE_MARK = /<\|message\|?>/i;

/**
 * Incremental, stateful sanitizer for STREAMING deltas. `stripReasoningTokens`
 * needs the whole message; live `assistant-delta` chunks would otherwise leak
 * raw `<|channel>thought…` reasoning tokens until the turn-end replacement.
 *
 * Per chunk it re-sanitizes the accumulated raw text and returns only the new,
 * clean suffix, while:
 *  - holding back a trailing partial special token split across chunks (e.g.
 *    "<|ch" then "annel|>"), so a half-token is never emitted;
 *  - suppressing canonical reasoning channels until a `final` channel opens.
 * If the sanitized output diverges from what was already emitted (a `final`
 * channel retroactively replaced earlier analysis), it stops emitting and lets
 * the turn-end `assistant-message` deliver the corrected full text.
 */
export class StreamSanitizer {
  private raw = '';
  private emitted = '';

  /** Returns the clean text to emit for this chunk (may be ''). */
  push(chunk: string): string {
    if (!chunk) return '';
    this.raw += chunk;

    // Hold back a trailing "<…" with no closing ">", which may be an incomplete
    // special token; sanitize only the safe prefix.
    const lt = this.raw.lastIndexOf('<');
    const safe = lt >= 0 && this.raw.indexOf('>', lt) === -1 ? this.raw.slice(0, lt) : this.raw;

    // Canonical reasoning in progress and no `final` channel yet → suppress.
    if (NONFINAL_OPEN.test(safe) && MESSAGE_MARK.test(safe) && !FINAL_OPEN.test(safe)) {
      return '';
    }

    const clean = stripReasoningTokens(safe);
    if (clean.startsWith(this.emitted)) {
      const delta = clean.slice(this.emitted.length);
      this.emitted = clean;
      return delta;
    }
    // Non-prefix rewrite (final channel replaced earlier analysis). Can't retract
    // already-streamed text mid-turn; stop here, turn-end replacement corrects it.
    this.emitted = clean;
    return '';
  }

  /** Flush any held-back tail at end of stream (may be ''). */
  flush(): string {
    const clean = stripReasoningTokens(this.raw);
    if (clean.startsWith(this.emitted)) {
      const delta = clean.slice(this.emitted.length);
      this.emitted = clean;
      return delta;
    }
    return '';
  }
}
