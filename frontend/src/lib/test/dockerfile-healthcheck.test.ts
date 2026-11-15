// src/lib/test/dockerfile-healthcheck.test.ts — the frontend image's HEALTHCHECK, EXECUTED.
//
// ⛔ THE DEFECT. `frontend/Dockerfile`'s HEALTHCHECK ran
//
//     bun run -e "fetch('http://localhost:3000').then(...)"
//
// `bun run` expects a FILE OR SCRIPT NAME. Given `-e` it prints its usage banner, evaluates
// nothing, and exits 0 — so the check reported `healthy` unconditionally, with the server dead.
// `bun -e` (no `run`) evaluates the script and propagates its exit code.
//
// ⚠️ AND THIS GATES NOTHING IN PRODUCTION. Said here as plainly as in the Dockerfile so nobody
// re-reads this file as a P1 that was sat on: Kubernetes ignores a container's own HEALTHCHECK and
// uses its own httpGet liveness/readiness probes, and CI's smoke step curls the published port
// directly (.github/workflows/ci-cd.yaml, "Wait for ready + smoke tests") rather than consulting
// container health. The audience is `docker ps` / `docker compose` — a developer running the image
// locally, who was being told a dead frontend was healthy.
//
// ⛔ THE COMMAND IS READ OUT OF THE DOCKERFILE AND RUN, NOT GREPPED FOR. A `not.toContain('bun run
// -e')` assertion pins a SPELLING: it passes on `bun  run -e`, on `bunx run -e`, and on any future
// invocation that is inert for a different reason. What matters is the PROPERTY — "this command
// exits non-zero when nothing is listening" — and the only way to assert a property of a shell
// command is to execute it. The port is substituted so the case cannot collide with whatever is on
// :3000 on the machine running the suite.
//
// ⚠️ BOTH DIRECTIONS, BECAUSE ONE IS NOT A HEALTHCHECK. A command that always fails also "exits
// non-zero when nothing is listening" and would report every healthy container as unhealthy. The
// live-server case is what makes the dead-server case mean something.
//
// NEGATIVE CONTROL, by name and measured: put `bun run -e` back in the Dockerfile and
// "⛔ the HEALTHCHECK fails when nothing is listening" reds with exit code 0.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

const DOCKERFILE = resolve(process.cwd(), 'Dockerfile');

/**
 * The HEALTHCHECK's `CMD` line, verbatim from the Dockerfile, with the hard-coded port swapped for
 * one this file owns. Line continuations are joined first — the directive spans two lines.
 */
function healthcheckCommand(port: number): string {
	const text = readFileSync(DOCKERFILE, 'utf8');
	// NON-VACUITY: a moved or renamed Dockerfile must be a failure, not an empty match.
	expect(text.length, 'frontend/Dockerfile is empty or unreadable').toBeGreaterThan(200);

	const joined = text.replace(/\\\n\s*/g, ' ');
	const line = joined.split('\n').find((l) => l.trimStart().startsWith('HEALTHCHECK'));
	expect(line, 'no HEALTHCHECK directive in frontend/Dockerfile').toBeTruthy();

	const cmd = line!.slice(line!.indexOf(' CMD ') + ' CMD '.length).trim();
	expect(cmd, 'the HEALTHCHECK has no CMD').not.toBe('');
	// The directive hard-codes 3000 (it runs inside the image, where PORT is fixed). Nothing else in
	// the command is a bare 3000, so this substitution is exact.
	expect(cmd, 'the HEALTHCHECK no longer names port 3000 — update this substitution').toContain(
		'3000'
	);
	return cmd.replaceAll('3000', String(port));
}

/** Run a shell command and resolve its exit code — what dockerd reads to decide health. */
function exitCodeOf(cmd: string): Promise<number> {
	return new Promise((res, rej) => {
		const child = spawn('sh', ['-c', cmd], { stdio: 'ignore' });
		child.on('error', rej);
		child.on('close', (code) => res(code ?? -1));
	});
}

/** A server that answers 200 on any path, on an ephemeral port. */
function listenOk(): Promise<{ port: number; close: () => Promise<void> }> {
	return new Promise((res) => {
		const server: Server = createServer((_req, out) => {
			out.writeHead(200);
			out.end('ok');
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			res({
				port,
				close: () => new Promise<void>((done) => server.close(() => done()))
			});
		});
	});
}

describe("the frontend image's HEALTHCHECK actually checks something", () => {
	it('⛔ the HEALTHCHECK fails when nothing is listening', async () => {
		// A port nothing is bound to. `fetch` rejects, the script's catch exits 1 — unless the
		// command never evaluated the script at all, which is the defect.
		const code = await exitCodeOf(healthcheckCommand(59_231));
		expect(
			code,
			code === 0
				? 'the HEALTHCHECK reported HEALTHY against a closed port. `bun run -e` prints its ' +
						'usage banner, evaluates nothing and exits 0 — use `bun -e`.'
				: undefined
		).not.toBe(0);
	}, 30_000);

	it('the HEALTHCHECK passes against a live server — otherwise it is not a check, just a failure', async () => {
		const server = await listenOk();
		try {
			expect(await exitCodeOf(healthcheckCommand(server.port))).toBe(0);
		} finally {
			await server.close();
		}
	}, 30_000);

	it('the build stage does not fall back to an unfrozen install', async () => {
		// ⚠️ A TEXT ASSERTION, DECLARED AS SUCH — the only one in this file. There is no property of
		// a running process to measure here: `bun install --frozen-lockfile || bun install` behaves
		// IDENTICALLY to the frozen form for as long as the lock is good, and differs only on the day
		// it drifts, inside a docker build this suite does not run. The fallback resolved DIFFERENT
		// versions into the shipped image and reported success. Verified before removal:
		// `bun install --frozen-lockfile` against the committed frontend/bun.lock exits 0.
		const text = readFileSync(DOCKERFILE, 'utf8');
		const installLines = text
			.split('\n')
			.filter((l) => /^\s*RUN\s+bun install/.test(l))
			.map((l) => l.trim());
		expect(installLines, 'no `RUN bun install` in the Dockerfile at all').not.toEqual([]);
		for (const line of installLines) {
			expect(line, 'the build falls back to an unfrozen install').not.toContain('||');
			expect(line, 'the build does not pin the lockfile').toContain('--frozen-lockfile');
		}
	});
});
