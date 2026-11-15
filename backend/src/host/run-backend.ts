// src/host/run-backend.ts — Phase 2-C: the pluggable run-execution boundary.
//
// A flow run talks to the trusted host over ONE stdio protocol (init frame on
// stdin line 0, bidirectional llm_request/llm_response, NDJSON TraceEvents on
// stdout — see db/trace-types.ts). run-controller.ts owns that protocol; this
// module owns ONLY *where the runner process lives*, behind a `RunBackend`:
//
//   • SubprocessBackend (default) — a Bun.spawn child INSIDE the backend pod.
//     The only enforceable resource boundary in Bun; used on macOS dev, CI, and
//     single-node/self-host. Behaviour is byte-identical to the pre-2-C code.
//   • K8sRunBackend — ONE Kata-isolated Pod per run. The host attaches to the
//     pod's stdin/stdout OVER THE API SERVER (control plane), so the run pod can
//     keep ZERO network egress and NO secrets: a user session's AI/block code
//     cannot reach the network out-of-the-box, and a VM boundary contains a
//     kernel escape. Portable: vanilla k8s + a documented Kata RuntimeClass.
//
// runner-entry.ts and the stdio protocol are UNCHANGED — only the transport of
// those bytes differs. The k8s client is imported lazily so the subprocess /
// runner path never loads it.
import os from 'node:os';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { config } from '../config';
import type { InitFrame, LlmResponseFrame } from '../db/trace-types';
import { log } from './logger';

const RUNNER_ENTRY = path.resolve(import.meta.dir, '..', 'exec', 'runner-entry.ts');
/** Path to runner-entry inside the run image (Dockerfile WORKDIR=/app). */
const RUNNER_ENTRY_IN_IMAGE = '/app/src/exec/runner-entry.ts';
/** Writable scratch mount inside a Kata run pod (rootfs is read-only). */
const POD_SCRATCH = '/run-scratch';

// bun (like V8/Node) reserves several GB of VIRTUAL address space at startup, so
// an RLIMIT_AS below ~4GB makes bun abort with SIGTRAP before any block runs
// (verified on Linux: --as<=3072MB crashes exit 133, 4096MB starts). RLIMIT_AS
// therefore can't double as a tight RSS cap for a bun runner — in prod the real
// memory ceiling is the k8s container cgroup limit (memory.max). We keep prlimit
// only as a coarse runaway-mmap backstop, adding bun's virtual-address floor on
// top of the configured per-run budget so the subprocess can actually start.
const BUN_VIRTUAL_FLOOR_MB = 4096;

/** Cap untrusted runner stderr before it reaches the host log. A malicious or buggy
 *  block can emit unbounded output (including anything it leaked to stderr); logged
 *  verbatim that floods the operator/co-tenant-readable backend pod logs. This bounds
 *  ONLY the diagnostic log line — the run's own persisted TraceEvents are unaffected. */
export const STDERR_LOG_CAP = 2048;
export function truncateForLog(text: string, cap = STDERR_LOG_CAP): string {
  return text.length <= cap
    ? text
    : `${text.slice(0, cap)}…[truncated ${text.length - cap} chars]`;
}

/** Pure, unit-testable: the spawn argv. prlimit (RLIMIT_AS mem cap) is Linux-only
 *  — on darwin the only backstop is the wall-clock timeout + SIGKILL. */
export function buildSpawnCmd(
  runnerPath: string,
  memMb: number,
  platform: NodeJS.Platform,
): string[] {
  const base = ['bun', 'run', runnerPath];
  if (platform === 'linux') {
    const asMb = memMb + BUN_VIRTUAL_FLOOR_MB;
    return ['prlimit', `--as=${asMb * 1024 * 1024}`, ...base];
  }
  return base;
}

/** Allowlist env — the runner must NOT see DATABASE_URL, ANTHROPIC_API_KEY, etc. */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'BUN_INSTALL']) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

/** Split a byte/string stream into trimmed, non-empty NDJSON lines. Works for
 *  both a Bun ReadableStream<Uint8Array> (subprocess stdout) and a Node Readable
 *  (k8s attach stdout). */
export async function* lineSplit(
  src: AsyncIterable<Uint8Array | string>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of src) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  const tail = buf.trim();
  if (tail) yield tail;
}

/** The transport-agnostic handle the controller pumps. */
export interface RunChannel {
  /** Serialise + write a frame to the runner's stdin (init, then llm_response). */
  writeFrame(frame: InitFrame | LlmResponseFrame): void;
  /** Runner stdout as NDJSON lines; completes when the runner exits. */
  lines: AsyncIterable<string>;
  /** Release the run's resources (scratch dir / delete pod). Best-effort. */
  dispose(): Promise<void>;
}

export interface RunStartArgs {
  runId: string;
  /** Abort (idle watchdog / cancel) → kill the subprocess / delete the pod. */
  signal: AbortSignal;
}

export interface RunBackend {
  /** Start a runner and return its stdio channel. The caller writes the init
   *  frame via `channel.writeFrame` once this resolves. */
  start(args: RunStartArgs): Promise<RunChannel>;
}

// ---------------------------------------------------------------------------
// SubprocessBackend — the in-pod Bun.spawn child (default; dev/CI/self-host).
// ---------------------------------------------------------------------------

class SubprocessBackend implements RunBackend {
  async start({ runId, signal }: RunStartArgs): Promise<RunChannel> {
    const scratchDir = path.join(os.tmpdir(), `cp-run-${runId}`);
    await mkdir(scratchDir, { recursive: true });
    const cmd = buildSpawnCmd(RUNNER_ENTRY, config.run.memMb, process.platform);
    const proc = Bun.spawn(cmd as string[], {
      cwd: scratchDir,
      env: scrubbedEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
      timeout: config.run.maxRunMs,
      killSignal: 'SIGKILL',
    }) as Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

    // Drain stderr (diagnostics) without blocking — best effort.
    void (async () => {
      try {
        const text = await new Response(proc.stderr).text();
        if (text.trim()) log.error('run_runner_stderr', { runId, stderr: truncateForLog(text.trim()) });
      } catch {
        /* ignore */
      }
    })();

    return {
      writeFrame(frame) {
        try {
          proc.stdin.write(`${JSON.stringify(frame)}\n`);
          proc.stdin.flush();
        } catch {
          /* runner gone */
        }
      },
      lines: lineSplit(proc.stdout as AsyncIterable<Uint8Array>),
      async dispose() {
        try {
          await rm(scratchDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// K8sRunBackend — one Kata-isolated Pod per run, host-attached over the API.
// ---------------------------------------------------------------------------

/** Pure, unit-testable: the per-run Pod manifest. No secrets, no SA token, no
 *  network egress (the runs namespace carries a default-deny-egress policy and
 *  the only channel out is the host's attach stream). runtimeClass empty → the
 *  cluster default runtime (documented weaker degrade); 'kata' in prod. */
export function buildRunPod(runId: string, cfg = config): Record<string, unknown> {
  const k = cfg.run.k8s;
  const spec: Record<string, unknown> = {
    restartPolicy: 'Never',
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    activeDeadlineSeconds: Math.ceil(cfg.run.maxRunMs / 1000) + 15,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    containers: [
      {
        name: 'runner',
        image: k.image,
        command: ['bun', 'run', RUNNER_ENTRY_IN_IMAGE],
        workingDir: POD_SCRATCH,
        // Minimal env — NO DATABASE_URL / provider keys. HOME+TMPDIR point at the
        // writable emptyDir (rootfs is read-only; bun caches transpiles under HOME).
        env: [
          { name: 'HOME', value: POD_SCRATCH },
          { name: 'TMPDIR', value: POD_SCRATCH },
        ],
        stdin: true,
        stdinOnce: true,
        tty: false,
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
        resources: {
          requests: { cpu: '100m', memory: `${Math.min(k.memoryRequestMb, cfg.run.memMb)}Mi` },
          limits: { cpu: k.cpuLimit, memory: `${cfg.run.memMb}Mi` },
        },
        volumeMounts: [{ name: 'scratch', mountPath: POD_SCRATCH }],
      },
    ],
    volumes: [{ name: 'scratch', emptyDir: {} }],
  };
  if (k.runtimeClass) spec.runtimeClassName = k.runtimeClass;
  if (k.imagePullSecret) spec.imagePullSecrets = [{ name: k.imagePullSecret }];
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `cp-run-${runId}`,
      namespace: k.namespace,
      labels: { app: 'commonpractice', 'cp-run': runId },
    },
    spec,
  };
}

// We drive run pods with the `kubectl` BINARY rather than a JS k8s client: Bun's
// HTTPS/HTTP2 stack cannot complete a connection to the k3s apiserver (it returns
// "socket connection closed unexpectedly" where curl/kubectl from the same pod get
// a normal 401), so an in-process fetch-based client is a dead end here. kubectl
// also gives us `attach` for free — the exact bidirectional stdio channel the
// runner protocol needs, identical in shape to the subprocess pipes. kubectl uses
// the pod's in-cluster config (KUBERNETES_SERVICE_HOST + the mounted SA token/CA)
// automatically. RBAC: a Role in the runs namespace (pods + pods/attach).
const KUBECTL = process.env.RUN_KUBECTL_BIN || 'kubectl';

// ⛔ Do NOT rely on kubectl's automatic in-cluster config here. When that detection fails for
// ANY reason, kubectl does not error — it silently falls back to the legacy default server
// `http://localhost:8080`, and the run dies with a connection-refused that names a port nothing
// in this cluster listens on. Observed in prod 2026-08-05: a real "Run this solution" click
// failed with
//
//   kubectl create run pod failed: error validating "STDIN": failed to download openapi:
//   Get "http://localhost:8080/openapi/v2?timeout=15s": dial tcp [::1]:8080: connection refused
//
// while `kubectl get --raw /version` from the same container at the same moment worked. The
// trigger is intermittent and was NOT identified; what is certain is the failure SHAPE, so this
// removes the shape rather than guessing at the trigger: given an explicit kubeconfig, kubectl
// has no default to fall back TO, and a broken token/CA becomes a loud auth error instead of a
// silent connection to nothing.
//
// `tokenFile` (not an inline token) is deliberate on two counts: the projected service-account
// token ROTATES roughly hourly, and kubectl re-reads the file per invocation, so nothing goes
// stale; and the token never lands on argv where `/proc/*/cmdline` would expose it.
//
// Verified in the live pod: with KUBERNETES_SERVICE_HOST/PORT deliberately unset (simulating the
// failed detection), the default flags reproduce the localhost:8080 fallback exactly, and this
// kubeconfig succeeds. Both spellings succeed with the env intact.
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** Explicit in-cluster kubeconfig. Throws — never returns a config that could point at a default. */
export function buildInClusterKubeconfig(
  env: Record<string, string | undefined> = process.env,
  saDir: string = SA_DIR,
): string {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? env.KUBERNETES_SERVICE_PORT_HTTPS;
  if (!host || !port) {
    throw new Error(
      'RUN_BACKEND=k8s needs in-cluster credentials: KUBERNETES_SERVICE_HOST/PORT are unset. ' +
        'Refusing to run kubectl without an explicit server — it would silently target ' +
        'http://localhost:8080 and fail with a misleading connection-refused.',
    );
  }
  // IPv6 literals need bracketing in a URL authority; IPv4/DNS names must not be bracketed.
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: in-cluster',
    '  cluster:',
    `    server: https://${authority}`,
    `    certificate-authority: ${saDir}/ca.crt`,
    'users:',
    '- name: in-cluster',
    '  user:',
    `    tokenFile: ${saDir}/token`,
    'contexts:',
    '- name: in-cluster',
    '  context:',
    '    cluster: in-cluster',
    '    user: in-cluster',
    'current-context: in-cluster',
    '',
  ].join('\n');
}

/** Written once per process; kubectl re-reads `tokenFile` itself, so this never needs refreshing. */
let kubeconfigPath: Promise<string> | undefined;
function inClusterKubeconfigPath(): Promise<string> {
  kubeconfigPath ??= (async () => {
    const body = buildInClusterKubeconfig();
    const target = path.join(os.tmpdir(), 'cp-in-cluster-kubeconfig.yaml');
    await Bun.write(target, body);
    return target;
  })();
  return kubeconfigPath;
}

// Ceiling on a one-shot kube-apiserver call (the pod create). `kubectl wait` carries its own,
// much longer, `--timeout` because it legitimately blocks on scheduling + image pull; a plain
// create is a single fast write, so anything past this is the apiserver being unreachable.
const KUBECTL_API_TIMEOUT_S = 15;

/**
 * @param timeoutMs wall-clock kill for the kubectl child. WITHOUT one an unresponsive
 *   kube-apiserver hangs the await forever: `start()` has not returned yet, so the caller has
 *   not armed its abort timer (resetIdle) — nothing else in the system can end that run, and the
 *   sandbox row stays `running` for good. `--request-timeout` on the kubectl side covers the REST
 *   call; this covers kubectl wedging anywhere else (TLS/exec/DNS) and is the outer backstop.
 */
async function kubectlRun(
  args: string[],
  stdin?: string,
  timeoutMs?: number,
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([KUBECTL, `--kubeconfig=${await inClusterKubeconfigPath()}`, ...args], {
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: a kubectl blocked on a dead socket may not run its signal handler,
      // and `proc.exited` must settle or we are back to the hang we are eliminating.
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
  }
  try {
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return {
      code,
      stderr: timedOut ? `timed out after ${timeoutMs}ms; ${stderr.trim()}`.trim() : stderr.trim(),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class K8sRunBackend implements RunBackend {
  async start({ runId, signal }: RunStartArgs): Promise<RunChannel> {
    const ns = config.run.k8s.namespace;
    const podName = `cp-run-${runId}`;
    if (!config.run.k8s.image) {
      throw new Error('RUN_IMAGE must be set for RUN_BACKEND=k8s');
    }
    // Resolved before the first kubectl call so the fire-and-forget delete below can stay sync,
    // and so a missing in-cluster identity fails HERE with a named error rather than as a
    // localhost:8080 connection-refused three steps later.
    const kubeconfig = await inClusterKubeconfigPath();

    let deleted = false;
    const deletePod = () => {
      if (deleted) return;
      deleted = true;
      // best-effort, fire-and-forget — activeDeadlineSeconds + a sweeper reap orphans.
      Bun.spawn(
        [
          KUBECTL,
          `--kubeconfig=${kubeconfig}`,
          'delete', 'pod', podName, '-n', ns, '--force', '--grace-period=0', '--wait=false',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
    };

    // 1. Create the run pod. Bounded on BOTH sides (see kubectlRun): this await sits before the
    //    caller arms the run's abort timer, so an unreachable apiserver here would strand the run
    //    forever with its sandbox stuck `running`. Failing fast instead surfaces a normal run error.
    const created = await kubectlRun(
      ['create', '-n', ns, '-f', '-', `--request-timeout=${KUBECTL_API_TIMEOUT_S}s`],
      JSON.stringify(buildRunPod(runId)),
      KUBECTL_API_TIMEOUT_S * 1000 + 2000,
    );
    if (created.code !== 0) throw new Error(`kubectl create run pod failed: ${created.stderr}`);

    try {
      // 2. Wait until Running. The runner blocks on the init frame and emits no
      //    stdout until we attach + send it, so there is no startup race. Generous
      //    timeout covers schedule + Kata VM boot + a cold image pull.
      const slack = 15;
      const timeoutS = Math.ceil(config.run.maxRunMs / 1000) + slack;
      const waited = await kubectlRun([
        'wait', `pod/${podName}`, '-n', ns,
        '--for=jsonpath={.status.phase}=Running', `--timeout=${timeoutS}s`,
      ]);
      if (signal.aborted) throw new Error('run aborted before pod started');
      if (waited.code !== 0) throw new Error(`run pod ${podName} not Running: ${waited.stderr}`);
    } catch (err) {
      deletePod();
      throw err;
    }

    // 3. Attach — kubectl wires the container's stdin/stdout/stderr to this child's
    //    pipes, giving the same RunChannel shape as the subprocess backend.
    const attach = Bun.spawn(
      [KUBECTL, `--kubeconfig=${kubeconfig}`, 'attach', '-i', '-q', '-c', 'runner', '-n', ns, podName],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    void (async () => {
      try {
        const t = await new Response(attach.stderr).text();
        if (t.trim()) log.error('run_attach_stderr', { runId, stderr: truncateForLog(t.trim()) });
      } catch {
        /* ignore */
      }
    })();

    const tearDown = () => {
      try {
        attach.kill();
      } catch {
        /* ignore */
      }
      deletePod();
    };
    if (signal.aborted) tearDown();
    else signal.addEventListener('abort', tearDown, { once: true });

    return {
      writeFrame(frame) {
        try {
          attach.stdin.write(`${JSON.stringify(frame)}\n`);
          attach.stdin.flush();
        } catch {
          /* runner gone */
        }
      },
      lines: lineSplit(attach.stdout as AsyncIterable<Uint8Array>),
      async dispose() {
        tearDown();
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let _backend: RunBackend | null = null;

/** The process-wide run backend, chosen by RUN_BACKEND (config.run.backend). */
export function getRunBackend(): RunBackend {
  if (!_backend) {
    _backend = config.run.backend === 'k8s' ? new K8sRunBackend() : new SubprocessBackend();
  }
  return _backend;
}

/** Tests: override the backend (and reset with `null`). */
export function __setRunBackendForTests(backend: RunBackend | null): void {
  _backend = backend;
}
