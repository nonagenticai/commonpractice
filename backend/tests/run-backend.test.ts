// tests/run-backend.test.ts — Phase 2-C: the Kata pod manifest + line splitter
// are pure/host-side and unit-tested here (no live cluster). The SubprocessBackend
// is exercised end-to-end by the run + block-test suites.
import { test, expect } from 'bun:test';
import {
  buildRunPod,
  lineSplit,
  truncateForLog,
  STDERR_LOG_CAP,
  buildInClusterKubeconfig,
} from '../src/host/run-backend';
import { config } from '../src/config';

function cfgWith(k8s: Partial<typeof config.run.k8s>) {
  return {
    ...config,
    run: { ...config.run, maxRunMs: 30000, memMb: 512, k8s: { ...config.run.k8s, ...k8s } },
  } as typeof config;
}

test('buildRunPod: Kata-isolated, no SA token, no secrets, hardened, scratch-mounted', () => {
  const pod = buildRunPod('abc-123', cfgWith({
    namespace: 'cp-runs',
    runtimeClass: 'kata',
    image: 'registry/commonpractice-backend:latest',
    cpuLimit: '1',
    imagePullSecret: 'registry-pull-secret',
  })) as any;

  expect(pod.kind).toBe('Pod');
  expect(pod.metadata.name).toBe('cp-run-abc-123');
  expect(pod.metadata.namespace).toBe('cp-runs');
  expect(pod.metadata.labels['cp-run']).toBe('abc-123');

  const spec = pod.spec;
  expect(spec.runtimeClassName).toBe('kata'); // the VM boundary
  expect(spec.restartPolicy).toBe('Never');
  expect(spec.automountServiceAccountToken).toBe(false); // the runner gets NO API access
  expect(spec.enableServiceLinks).toBe(false);
  expect(spec.activeDeadlineSeconds).toBe(45); // ceil(30000/1000)+15
  expect(spec.securityContext.runAsNonRoot).toBe(true);

  const c = spec.containers[0];
  expect(c.name).toBe('runner');
  expect(c.image).toBe('registry/commonpractice-backend:latest');
  expect(c.command).toEqual(['bun', 'run', '/app/src/exec/runner-entry.ts']);
  expect(c.stdin).toBe(true); // host attaches stdin for the init/llm_response channel
  expect(c.stdinOnce).toBe(true);
  expect(c.tty).toBe(false);
  expect(c.securityContext.readOnlyRootFilesystem).toBe(true);
  expect(c.securityContext.capabilities.drop).toEqual(['ALL']);
  expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
  expect(c.resources.limits.memory).toBe('512Mi');
  // NO DATABASE_URL / provider keys reach the runner pod.
  const envNames = (c.env as { name: string }[]).map((e) => e.name);
  expect(envNames).toEqual(['HOME', 'TMPDIR']);
  expect(c.workingDir).toBe('/run-scratch');
  expect(c.volumeMounts[0].mountPath).toBe('/run-scratch');
  expect(spec.volumes[0].emptyDir).toBeDefined();
  expect(spec.imagePullSecrets).toEqual([{ name: 'registry-pull-secret' }]);
});

test('buildRunPod: empty runtimeClass + pull secret → fields omitted (portable defaults)', () => {
  const pod = buildRunPod('x', cfgWith({ runtimeClass: '', image: 'img', imagePullSecret: '' })) as any;
  expect('runtimeClassName' in pod.spec).toBe(false);
  expect('imagePullSecrets' in pod.spec).toBe(false);
});

test('buildRunPod: small scheduling request preserves the execution memory limit', () => {
  const cfg = cfgWith({ memoryRequestMb: 64 });
  const pod = buildRunPod('small-tool', cfg) as any;
  expect(pod.spec.containers[0].resources.requests.memory).toBe('64Mi');
  expect(pod.spec.containers[0].resources.limits.memory).toBe('512Mi');
  const smallerLimit = buildRunPod('small-limit', { ...cfg, run: { ...cfg.run, memMb: 32 } }) as any;
  expect(smallerLimit.spec.containers[0].resources.requests.memory).toBe('32Mi');
  expect(smallerLimit.spec.containers[0].resources.limits.memory).toBe('32Mi');
});

test('RUN_MEMORY_REQUEST_MB reaches new run pods without changing RUN_MEM_MB', async () => {
  const proc = Bun.spawn(['bun', '-e', `
    const { buildRunPod } = await import('./src/host/run-backend');
    console.log(JSON.stringify(buildRunPod('env-check').spec));
  `], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, RUN_MEMORY_REQUEST_MB: '64', RUN_MEM_MB: '512' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  const spec = JSON.parse(out);
  expect(spec.containers[0].resources.requests.memory).toBe('64Mi');
  expect(spec.containers[0].resources.limits.memory).toBe('512Mi');
});

test('truncateForLog: short input passes through unchanged', () => {
  const s = 'a short diagnostic line';
  expect(truncateForLog(s)).toBe(s);
  expect(truncateForLog('', 8)).toBe('');
  expect(truncateForLog('x'.repeat(STDERR_LOG_CAP))).toHaveLength(STDERR_LOG_CAP); // at the cap, untouched
});

test('truncateForLog: caps untrusted stderr so a flood cannot fill the host log', () => {
  const flood = 'LEAK'.repeat(100_000); // 400k chars of attacker-controlled output
  const out = truncateForLog(flood);
  expect(out.length).toBeLessThan(flood.length);
  expect(out.startsWith('LEAK')).toBe(true);
  expect(out).toContain(`[truncated ${flood.length - STDERR_LOG_CAP} chars]`);
  // the kept prefix is exactly the cap (plus the truncation marker)
  expect(out.slice(0, STDERR_LOG_CAP)).toBe(flood.slice(0, STDERR_LOG_CAP));
});

test('lineSplit: splits NDJSON across chunk boundaries, trims, drops blanks, flushes tail', async () => {
  async function* chunks(): AsyncIterable<Uint8Array | string> {
    yield '{"a":1}\n{"b":'; // split mid-line
    yield '2}\n\n  \n'; // blank lines ignored
    yield '{"c":3}'; // no trailing newline → flushed as tail
  }
  const out: string[] = [];
  for await (const line of lineSplit(chunks())) out.push(line);
  expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
});

// ── in-cluster kubeconfig ────────────────────────────────────────────────────────────────────
//
// Regression cover for a CONFIRMED prod failure (2026-08-05): a real "Run this solution" click
// died with
//
//   kubectl create run pod failed: error validating "STDIN": failed to download openapi:
//   Get "http://localhost:8080/openapi/v2?timeout=15s": dial tcp [::1]:8080: connection refused
//
// kubectl's automatic in-cluster detection had failed, and instead of erroring it fell back to
// the legacy default server. The point of an explicit kubeconfig is that there is no default
// left to fall back to, so these tests assert the two properties that guarantee it: the server
// is always the in-cluster endpoint, and a missing identity THROWS rather than degrading.
test('in-cluster kubeconfig targets the apiserver from the env, never a default', () => {
  const kc = buildInClusterKubeconfig(
    { KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443' },
    '/sa',
  );
  expect(kc).toContain('server: https://10.43.0.1:443');
  expect(kc).not.toContain('localhost');
  expect(kc).not.toContain('8080');
  // tokenFile, not an inline token: the projected token rotates ~hourly and kubectl re-reads the
  // file, and nothing secret reaches argv.
  expect(kc).toContain('tokenFile: /sa/token');
  expect(kc).toContain('certificate-authority: /sa/ca.crt');
});

test('an IPv6 apiserver host is bracketed so the server URL stays parseable', () => {
  const kc = buildInClusterKubeconfig(
    { KUBERNETES_SERVICE_HOST: 'fd00::1', KUBERNETES_SERVICE_PORT: '443' },
    '/sa',
  );
  expect(kc).toContain('server: https://[fd00::1]:443');
});

test('KUBERNETES_SERVICE_PORT_HTTPS is accepted when KUBERNETES_SERVICE_PORT is absent', () => {
  const kc = buildInClusterKubeconfig(
    { KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT_HTTPS: '443' },
    '/sa',
  );
  expect(kc).toContain('server: https://10.43.0.1:443');
});

test('a missing in-cluster identity throws instead of silently targeting localhost:8080', () => {
  expect(() => buildInClusterKubeconfig({}, '/sa')).toThrow(/KUBERNETES_SERVICE_HOST/);
  expect(() => buildInClusterKubeconfig({ KUBERNETES_SERVICE_HOST: '10.43.0.1' }, '/sa')).toThrow();
});
