// tests/spawn-cmd.test.ts — the cross-platform spawn argv (pure, no spawn).
import { test, expect } from 'bun:test';
import { buildSpawnCmd } from '../src/host/run-backend';

test('linux wraps the runner in prlimit for an RLIMIT_AS mem cap (+bun virtual floor)', () => {
  // bun needs ~4GB virtual address space to start, so the --as cap is the
  // configured budget plus a 4096MB floor (see buildSpawnCmd). A bare 256MB cap
  // would SIGTRAP bun before any block runs.
  const cmd = buildSpawnCmd('/x/runner.ts', 256, 'linux');
  expect(cmd[0]).toBe('prlimit');
  expect(cmd[1]).toBe(`--as=${(256 + 4096) * 1024 * 1024}`);
  expect(cmd.slice(2)).toEqual(['bun', 'run', '/x/runner.ts']);
});

test('darwin (and other non-linux) omit prlimit — timeout+SIGKILL is the backstop', () => {
  expect(buildSpawnCmd('/x/runner.ts', 256, 'darwin')).toEqual(['bun', 'run', '/x/runner.ts']);
  expect(buildSpawnCmd('/x/runner.ts', 256, 'win32')).toEqual(['bun', 'run', '/x/runner.ts']);
});
