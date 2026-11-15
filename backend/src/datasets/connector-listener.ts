// src/datasets/connector-listener.ts — the event spine (Phase 2-A, "no polling").
// At boot the server LISTENs on two Postgres channels (zero new infra — postgres.js
// already drives the app):
//   • cp_connector_refresh — a refresh was requested (by the /events ingress on ANY
//     replica). We run refreshConnector(); the advisory lock serializes duplicates.
//   • cp_connector_synced  — a refresh finished; we fan out to the connector SSE
//     stream so the Datasets screen updates reactively, no client polling.
// Started from server.ts only (like the sandbox watchdog) so `bun test` never LISTENs.
//
// ⛔ THE REGISTRATION DOES NOT RUN ON A POOL, AND MUST NOT. This file used to call
// `queryClient.listen(...)`, which reads as "reuse the pool we already have" and is not what
// postgres-js does: it lazily memoises a SEPARATE hidden `max:1` client (index.js:150-165) that
// inherits only the parent's DSN — the session POOLER. That connection was pinned for the life of
// the pod, counted against pgbouncer's shared `pool_size`, and appeared in no budget. Worse, the
// server sets `idle_session_timeout = '10min'` cluster-wide, and a LISTEN-only session is idle
// outside a transaction by definition, so POSTGRES KILLED IT EVERY TEN MINUTES. postgres-js
// re-LISTENed quietly, so nothing looked wrong and the connection count stayed put — but every
// NOTIFY that landed in the kill→re-LISTEN gap was dropped, permanently, with no log line. And if
// the re-LISTEN itself failed, index.js:159 swallowed the rejection (`.catch(() => {})`) while this
// module's `started` flag stayed true, so the channel died for the life of the pod, silently.
//
// The registration therefore runs on `listenClient` — an explicit, named, budgeted client on the
// DIRECT DSN — with OUR OWN notify/close supervisor below: bounded-backoff retries, a log line on
// every attempt, and connect/disconnect counters so the next such kill is a graph, not an
// archaeology exercise.
import { listenClient, listenHandlers } from '../db/client';
import { incCounter } from '../host/metrics';
import { log } from '../host/logger';
import { CHANNEL_REFRESH, CHANNEL_SYNCED, refreshConnector } from './connector-refresh';
import { CHANNEL_AGENT_TOOL_RESULT, onToolResultNotify } from '../ai/tool-rendezvous';

type SyncedSubscriber = (connectorId: string) => void;
const subscribers = new Set<SyncedSubscriber>();

/** Subscribe to "connector synced" events (the SSE route). Returns an unsubscribe. */
export function subscribeConnectorSynced(cb: SyncedSubscriber): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function fanoutSynced(connectorId: string): void {
  for (const cb of subscribers) {
    try {
      cb(connectorId);
    } catch {
      /* a slow/broken subscriber must not stall the listener */
    }
  }
}

// Bounded in-process refresh concurrency (refreshConnector itself serializes per
// connector via the advisory lock; this just caps parallel network fetches).
const MAX_CONCURRENT = 2;
let active = 0;
const pending: string[] = [];

function pump(): void {
  while (active < MAX_CONCURRENT && pending.length) {
    const id = pending.shift()!;
    active++;
    refreshConnector(id)
      .catch((err) => log.error('connector_refresh_failed', { component: 'connector', connectorId: id, err }))
      .finally(() => {
        active--;
        pump();
      });
  }
}

function enqueueRefresh(connectorId: string): void {
  if (!connectorId) return;
  if (!pending.includes(connectorId)) pending.push(connectorId);
  pump();
}

// ---- the LISTEN supervisor ----

/** A registration is live on the current connection. Reset by `onClose` — the old code set this
 *  once and never cleared it, so a dropped connection left a listener that listened to nothing. */
let started = false;
/** Shutdown latch: `end()`ing the client fires `onClose`, and without this we would answer our own
 *  shutdown by reconnecting. */
let stopped = false;
/** `startConnectorListener()` has been called and not stopped. Distinct from `started`: it is what
 *  tells `onClose` that a close is OURS to answer even when no registration is live yet. */
let armed = false;
/** A registration attempt is in flight. `onClose` must not race a second one alongside it. */
let registering = false;
/** Set by `onClose` — the connection died, so anything `register()` configured on it is gone. */
let sessionLost = false;
/** Consecutive-trouble counter; the backoff exponent. */
let attempts = 0;
/** When the current registration went live, so a FLAPPING session can be told from a healthy one. */
let lastSuccessAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** A session that held at least this long counts as healthy: losing it earns an immediate
 *  reconnect and a clean backoff slate. Anything shorter is flapping, and reconnecting at full
 *  speed would hammer the database exactly when it is least able to take it. */
const STABLE_MS = 60_000;
/** How many times a single attempt may re-register immediately because the session died underneath
 *  it, before falling back to the backoff. Bounds a hot loop against a connection that cannot
 *  survive its own registration. */
const MAX_IMMEDIATE_LAPS = 3;

function backoffMs(): number {
  return attempts === 0 ? 0 : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
}

/** Quote a channel as a Postgres identifier, matching what postgres-js's own `.listen()` sends. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * EVERY channel this pod listens on, and the handler for each.
 *
 * ⛔ ONE LIST, NOT A HAND-WRITTEN STATEMENT PLUS A HAND-WRITTEN `if/else`. Those were two places
 * that had to agree, and a channel added to one and forgotten in the other is a NOTIFY nobody ever
 * hears — with no error, because LISTENing to a channel nothing dispatches is perfectly legal SQL.
 * `register()` and `onNotify` now BOTH derive from this array, so a new channel is one line and
 * cannot half-land. tests/agent-tool-rendezvous.test.ts pins that the built statement is still ONE
 * statement covering every entry.
 *
 * ⚠️ THE MODULE IS STILL CALLED connector-listener AND THE LIST IS NO LONGER ONLY CONNECTORS. That
 * is deliberate and is not drift: a pod may hold exactly ONE pinned LISTEN session (db/client.ts's
 * `listenClient`, `max: 1`), because a registration is session state and a pool would deliver
 * NOTIFYs to whichever connection happened to have LISTENed. This file is that session's supervisor
 * — the backoff, the flap detection, the disconnect counters — so every channel in the process has
 * to register through it. Renaming the file is a larger, unrelated change.
 */
const CHANNELS: ReadonlyArray<readonly [string, (payload: string) => void]> = [
  [CHANNEL_REFRESH, (payload) => enqueueRefresh(payload)],
  [CHANNEL_SYNCED, (payload) => fanoutSynced(payload)],
  // The copilot's cross-replica frontend-tool rendezvous (ai/tool-rendezvous.ts). The payload is
  // the `${turnId}:${callId}` KEY only — the result itself is a row, because pg_notify caps at
  // 8000 bytes and a propose_block_draft result is a whole block draft. Every replica receives
  // this; only the one holding that waiter does any work.
  [CHANNEL_AGENT_TOOL_RESULT, (payload) => onToolResultNotify(payload)],
];

/** The channel names this pod registers, in registration order. Exported for the tests that pin
 *  the one-statement invariant. */
export const LISTEN_CHANNELS: readonly string[] = CHANNELS.map(([name]) => name);

/** The exact statement `register()` sends — built here so a test can assert its shape without
 *  opening a connection. ONE statement; see the ⚠️ on `register()`. */
export function buildRegisterStatement(): string {
  return `${CHANNELS.map(([name]) => `LISTEN ${ident(name)}`).join('; ')}; SET idle_session_timeout = 0`;
}

/**
 * Configure a session: both LISTENs and the idle-reaper override, as ONE simple-protocol statement.
 * Re-run in full after every disconnect — all three commands are SESSION state, and a new
 * connection has none of it.
 *
 * ⚠️ ONE STATEMENT, NOT THREE, AND THAT IS THE POINT. As three awaited statements this was not
 * atomic: postgres-js transparently opens a fresh connection for the next statement when the
 * current one dies, so a close mid-sequence left `register()` resolving happily over a session that
 * had missed everything issued before the break. Depending on where the break landed, the pod ended
 * up permanently missing one channel, both channels, or — subtlest — holding both channels with
 * `idle_session_timeout` back at the server default, which silently restores the ten-minute defect
 * this module exists to fix. postgres-js sends a parameterless `unsafe()` over the SIMPLE query
 * protocol (index.js: `simple: … args.length === 0`), so all three commands travel in a single
 * round trip and share one implicit transaction: the session is either fully configured or not
 * configured at all. `onClose` handles the second case; there is no third.
 *
 * ⚠️ `SET idle_session_timeout = 0` is a STATEMENT here, deliberately, and must not be "tidied up"
 * into the client's `connection: {}` startup parameters. pgbouncer's `ignore_startup_parameters`
 * does not list it, so as a startup param it would make every connection FAIL — not on the direct
 * path this is designed for, but on the FALLBACK path where LISTEN_DATABASE_URL is unset and
 * `listenUrl` is still the pooler. That is the path dev, CI, and the rollback deploy all take. As a
 * plain statement it is a USERSET GUC that succeeds on both.
 *
 * LISTEN takes an identifier, not a bind parameter, so it cannot be parameterised; the channel
 * names are module constants in connector-refresh.ts and never touch user input.
 */
async function register(): Promise<void> {
  await listenClient.unsafe(buildRegisterStatement());
}

/** One NOTIFY, off the wire. postgres-js hands us the channel, so one hook serves every channel. */
function onNotify(channel: string, payload: string): void {
  for (const [name, handle] of CHANNELS) {
    if (name !== channel) continue;
    try {
      handle(payload);
    } catch (err) {
      // One channel's handler must never take the listener down with it — the session is shared by
      // every channel in the process, and an unhandled throw here reaches postgres-js's connection
      // callback, not any caller of ours.
      log.error('connector_handler_threw', { component: 'connector', channel, err });
    }
    return;
  }
}

/**
 * The LISTEN connection went away — idle reaper, pooler reload, failover, network blip.
 *
 * ⛔ THE GUARD IS `armed`, NOT `started`, AND THE DIFFERENCE IS THE WHOLE BUG. `started` only
 * becomes true once `register()` has RESOLVED, so `if (!started) return` made this handler deaf for
 * the entire registration round trip — the one window in which a disconnect is most likely, because
 * re-registration happens precisely when the database is dropping connections. A close swallowed
 * there produced no reconnect, no counter, no log, and then a `listening on …` line about a session
 * that was listening to nothing. `armed` says "this listener wants a live registration", which is
 * true from `startConnectorListener()` onwards, so no close is ever silently absorbed again.
 */
function onClose(): void {
  if (stopped || !armed) return;
  const wasLive = started;
  const heldFor = lastSuccessAt ? Date.now() - lastSuccessAt : 0;
  started = false;
  sessionLost = true; // invalidates an in-flight register(), which re-runs rather than declaring success
  incCounter('connector_listen_disconnects_total');
  if (wasLive) {
    // A session that held its ground earns an immediate reconnect and a clean slate; one that died
    // young is flapping, and each flap must cost more than the last.
    attempts = heldFor >= STABLE_MS ? 0 : attempts + 1;
  }
  log.warn('listen_connection_closed', {
    component: 'connector',
    heldForMs: heldFor,
    retryInMs: backoffMs(),
  });
  // An attempt already in flight will notice `sessionLost` and loop on its own; scheduling a second
  // one alongside it would double-register and double-count.
  if (!registering) scheduleAttempt(backoffMs());
}

function scheduleAttempt(delayMs: number): void {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void attemptRegister();
  }, delayMs);
  // A retry timer must never be the reason the process stays alive.
  retryTimer.unref?.();
}

async function attemptRegister(): Promise<boolean> {
  if (stopped || registering) return started;
  registering = true;
  try {
    for (let lap = 0; lap < MAX_IMMEDIATE_LAPS; lap++) {
      if (stopped) return false;
      sessionLost = false;
      started = false;
      try {
        await register();
      } catch (err) {
        attempts++;
        // Every attempt logs. The failure this replaces logged nothing, ever.
        log.error('listen_registration_failed', {
          component: 'connector',
          attempt: attempts,
          retryInMs: backoffMs(),
          err,
        });
        scheduleAttempt(backoffMs());
        return false;
      }
      // `register()` returning proves the statement ran, NOT that the session it ran on still
      // exists. If the connection closed while we were mid-flight, we have just configured a
      // corpse — go again rather than logging a registration that isn't there.
      if (sessionLost) continue;
      started = true;
      lastSuccessAt = Date.now();
      incCounter('connector_listen_connects_total');
      log.info('listening_on_channels', { component: 'connector', channels: LISTEN_CHANNELS });
      return true;
    }
    // The connection could not survive its own registration this many times running. Stop spinning
    // and let the backoff have it.
    attempts++;
    log.error('listen_session_died_during_registration', {
      component: 'connector',
      laps: MAX_IMMEDIATE_LAPS,
      retryInMs: backoffMs(),
    });
    scheduleAttempt(backoffMs());
    return false;
  } finally {
    registering = false;
  }
}

/**
 * Begin LISTENing on the connector channels. Idempotent.
 *
 * Returns whether the registration is live. On failure it does NOT leave `started` set (the old
 * bug): a bounded-backoff retry is armed and the channel can still come up on its own. server.ts
 * calls this as `void startConnectorListener()` — a LISTEN failure has never blocked boot and must
 * not start to; the pod still serves every request, it just falls back to the client's own refresh.
 */
export async function startConnectorListener(): Promise<boolean> {
  if (started) return true;
  stopped = false;
  armed = true;
  listenHandlers.onNotify = onNotify;
  listenHandlers.onClose = onClose;
  return attemptRegister();
}

/** Stop supervising: cancel any pending retry and stop answering `onClose`. Call BEFORE
 *  `listenClient.end()` (or `closeConnection()`), or ending the client trips the reconnect. */
export function stopConnectorListener(): void {
  stopped = true;
  armed = false;
  started = false;
  attempts = 0;
  lastSuccessAt = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  listenHandlers.onNotify = undefined;
  listenHandlers.onClose = undefined;
}
