// tests/db-preflight-target.test.ts — db-preflight.sh must vouch for the database the tests
// ACTUALLY use, and must refuse to vouch for one whose schema is behind the tree.
//
// ⛔ WHY THIS IS A TEST AND NOT A COMMENT. The script's whole product is one sentence:
// "Preflight passed — a red test run now most likely means a REAL failure." Everything else it
// prints is diagnostics. On origin/main that sentence was reachable in two states where it is
// simply false, and both were measured on 2026-08-26:
//
//   1. It hardcoded `docker exec commonpractice-db` while `backend/.env` on this machine read
//      `…@localhost:5474/commonpractice` — a DIFFERENT container on a DIFFERENT port. Run with
//      DATABASE_URL pointing at port 5999, where NOTHING is listening, main still printed the
//      sentence and exited 0. A probe that bypasses the thing it vouches for cannot vouch for it.
//   2. Its schema check was `select count(*) from _migrations`, rendered as "✓ _migrations has 69
//      rows". 69 is a healthy-looking number; the tree had 73. A test touching anything the four
//      missing migrations add fails with a missing-column error that reads exactly like a real
//      regression — the ONE outcome this script exists to rule out. A count can only catch a DB
//      that was never migrated; it is blind to one that is merely STALE, and stale is the common
//      case, because a container outlives the branch that created it.
//
// A shell script nothing executes in CI is a script that rots, so the states are pinned here
// rather than described. Each case asserts the EXIT CODE *and* the specific sentence, because
// exit 0 with a scary-looking warning above it is still a pass, and that is the failure mode.
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const SCRIPT = fileURLToPath(new URL('../scripts/db-preflight.sh', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Run the script with an overridden DATABASE_URL and nothing else changed. */
function run(dsn: string) {
  const r = spawnSync('bash', [SCRIPT], {
    env: { ...process.env, DATABASE_URL: dsn },
    encoding: 'utf8',
    timeout: 120_000,
  });
  // Strip ANSI so assertions match the words, not the colour codes.
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(ANSI, '');
  return { status: r.status, out };
}

const PASS_SENTENCE = 'Preflight passed';

/**
 * Split a DSN on its STRUCTURE — `scheme://[user[:pass]@]host[:port]/db[?…]`.
 *
 * ⛔ EVERY FIELD EXCEPT THE SCHEME SITS TO THE RIGHT OF A PASSWORD THAT MAY CONTAIN '@', ':', '/'
 * OR '?'. So the authority is cut at the FIRST '/' after `://` (a '@' in the path can then never be
 * mistaken for the credential separator) and the credential at the LAST '@' inside it. The old
 * one-shot regex here used `[^:/@]+` for the user and `[^@]*` for the password, which silently
 * mis-parsed `p@ssw0rd` into a host of `ssw0rd@localhost` — i.e. the harness had the same
 * first-'@' bug as the script it is testing.
 */
export function splitDsn(dsn: string): {
	scheme: string;
	userinfo: string | null;
	user: string | null;
	password: string | null;
	hostport: string;
	host: string;
	port: string;
	path: string;
} {
	const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([\s\S]*)$/.exec(dsn);
	if (!m) throw new Error(`not a DSN: ${dsn}`);
	const rest = m[2]!;
	const slash = rest.indexOf('/');
	const authority = slash === -1 ? rest : rest.slice(0, slash);
	const path = slash === -1 ? '' : rest.slice(slash);
	const at = authority.lastIndexOf('@');
	const userinfo = at === -1 ? null : authority.slice(0, at);
	const hostport = at === -1 ? authority : authority.slice(at + 1);
	const colon = hostport.startsWith('[')
		? hostport.indexOf(':', hostport.indexOf(']'))
		: hostport.indexOf(':');
	const ui = userinfo === null ? null : /^([^:]*)(?::([\s\S]*))?$/.exec(userinfo)!;
	return {
		scheme: m[1]!,
		userinfo,
		user: ui ? ui[1]! : null,
		password: ui && ui[2] !== undefined ? ui[2] : null,
		hostport,
		host: colon === -1 ? hostport : hostport.slice(0, colon),
		port: colon === -1 ? '' : hostport.slice(colon + 1),
		path
	};
}

/** The DSN the script says it checked, lifted out of its `✓ target: …   (from …)` line. */
function targetDsn(out: string): string {
	const line = out.split('\n').find((l) => l.includes('target:')) ?? '';
	const m = /target:\s+(\S+)/.exec(line);
	if (!m) throw new Error(`the script printed no 'target:' line. Output was:\n${out}`);
	return m[1]!;
}

const realDsn = process.env.DATABASE_URL ?? '';
/** The harness's own view of the DSN under test. Parsed structurally, like the script now is. */
const REAL = (() => {
	try {
		return realDsn ? splitDsn(realDsn) : null;
	} catch {
		return null;
	}
})();

// A scratch database on the SAME server, so container resolution is exercised for real rather
// than stubbed. Suffixed with the pid: sibling sessions run this suite concurrently.
const scratchDb = `cp_preflight_stale_${process.pid}`;
let container = '';

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
}
function psqlOn(db: string, sql: string) {
  return docker(['exec', container, 'psql', '-U', REAL!.user!, '-d', db, '-tAc', sql]);
}

describe('db-preflight.sh vouches for the database the tests actually use', () => {
  beforeAll(() => {
    // ⛔ Non-vacuity, with LIVE assertions only.
    //
    // `expect(realDsn).not.toBe('')` used to lead this block. It can never fail: `tests/setup-env.ts`
    // is preloaded (bunfig.toml) and fills DATABASE_URL with `||=`, so by the time any test body
    // runs the variable is always set — a comment claiming non-vacuity, dressed as an assertion.
    // What CAN fail, and what really does turn this file into a green no-op when it does, is a DSN
    // this harness cannot take apart, or one whose port nothing publishes. Both are asserted, and
    // both are reachable: point DATABASE_URL at `postgres://oops` or at a dead port and this
    // beforeAll goes red instead of the suite silently vouching for nothing.
    expect(REAL, `could not parse DATABASE_URL: ${realDsn}`).not.toBeNull();
    expect(REAL!.user, 'DATABASE_URL carries no role to connect as').toBeTruthy();
    expect(REAL!.port, 'DATABASE_URL carries no explicit port').toMatch(/^\d+$/);
    expect(REAL!.path.replace('/', ''), 'DATABASE_URL names no database').toBeTruthy();

    const ps = docker(['ps', '--format', '{{.Names}}\t{{.Ports}}']);
    expect(ps.status, 'docker must be available — the script and CI both require it').toBe(0);
    const port = `:${REAL!.port}->`;
    container =
      (ps.stdout ?? '')
        .split('\n')
        .find((l) => l.includes(port))
        ?.split('\t')[0] ?? '';
    expect(container, `no running container publishes port ${REAL!.port}`).not.toBe('');

    docker([
      'exec', container, 'psql', '-U', REAL!.user!, '-d', 'postgres',
      '-c', `CREATE DATABASE ${scratchDb}`,
    ]);
    // A schema that LOOKS migrated but is behind: the table exists and holds only the first file.
    psqlOn(
      scratchDb,
      'CREATE TABLE _migrations (filename text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const first = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()[0]!;
    psqlOn(scratchDb, `INSERT INTO _migrations (filename) VALUES ('${first}')`);
  });

  afterAll(() => {
    if (container) {
      docker([
        'exec', container, 'psql', '-U', REAL!.user!, '-d', 'postgres',
        '-c', `DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE)`,
      ]);
    }
  });

  it('PASSES against the real, current test database', () => {
    const { status, out } = run(realDsn);
    expect(out).toContain('none missing from the tree');
    expect(out).toContain(PASS_SENTENCE);
    expect(status).toBe(0);
  });

  it('names the target it checked, with the credential redacted BY POSITION', () => {
    // ⛔ A SUBSTRING SEARCH CANNOT EXPRESS THIS ASSERTION. Two rounds of it were wrong here:
    //
    //   1. `expect(stdout).not.toContain(pw)` — the dev password is the word `commonpractice`,
    //      which also appears legitimately as the CONTAINER NAME `commonpractice-db` further down.
    //      Red on a working redaction.
    //   2. `expect(targetLine).not.toContain(pw)` — the "fix": scope it to the DSN line. Still
    //      unsound, and RED IN CI, where the password is `postgres`
    //      (`.github/workflows/ci-cd.yaml`: `postgresql://postgres:postgres@127.0.0.1:…`) and the
    //      SCHEME `postgresql://` contains the substring `postgres`. The assertion was simply
    //      `true` on correct output.
    //
    // A password is a value at a POSITION, not a spelling. So parse the printed DSN and pin the
    // whole thing: userinfo must be exactly `***`, and scheme/host/port/path must come back
    // BYTE-IDENTICAL — which a greedy over-redaction that ate the host would fail.
    const port = REAL!.port;
    const host = REAL!.host;
    const cases: { label: string; dsn: string; redacted: boolean }[] = [
      { label: 'the real dev DSN', dsn: realDsn, redacted: REAL!.userinfo !== null },
      {
        label: "CI's exact shape — the password is a substring of the scheme",
        dsn: `postgresql://postgres:postgres@127.0.0.1:${port}/commonpractice`,
        redacted: true,
      },
      { label: "a password containing '@'", dsn: `postgresql://u:p@ssw0rd@${host}:${port}/db`, redacted: true },
      { label: "a password containing ':'", dsn: `postgresql://u:p:ssw0rd@${host}:${port}/db`, redacted: true },
      { label: 'a user with no password', dsn: `postgresql://solo@${host}:${port}/db`, redacted: true },
      // ⚠️ The cosmetic wrong-fail the greedy `[^/]*@` invites: with NOTHING to redact it must not
      // reach forward and eat the host.
      { label: 'no credentials at all', dsn: `postgresql://${host}:${port}/db`, redacted: false },
    ];

    for (const c of cases) {
      const { out } = run(c.dsn);
      const printed = targetDsn(out);
      const want = splitDsn(c.dsn);
      const expected = c.redacted
        ? `${want.scheme}://***@${want.hostport}${want.path}`
        : c.dsn;
      expect(printed, `${c.label}: the target line must be safe to paste AND still correct`).toBe(
        expected,
      );
      const got = splitDsn(printed);
      expect(got.userinfo, `${c.label}: credential position`).toBe(c.redacted ? '***' : null);
      expect(got.hostport, `${c.label}: host:port must be untouched`).toBe(want.hostport);
      expect(got.path, `${c.label}: database must be untouched`).toBe(want.path);
    }

    // The specific leak the old `[^@/]*@` produced, named so this cannot regress quietly:
    // `p@ssw0rd` printed as `postgresql://***@ssw0rd@localhost:5474/…`. `ssw0rd` occurs nowhere
    // else in the output, so this negative is not a spelling collision waiting to happen.
    const leaky = run(`postgresql://u:p@ssw0rd@${host}:${port}/db`).out;
    expect(leaky, 'the tail of a password containing @ must not survive redaction').not.toContain(
      'ssw0rd',
    );
  });

  it('REFUSES a database whose schema is behind the tree, and NAMES the missing files', () => {
    const dsn = realDsn.replace(/\/[^/?]+(\?.*)?$/, `/${scratchDb}$1`);
    const { status, out } = run(dsn);
    const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(out).toContain('schema is STALE');
    // The NEWEST migration is the one a fresh feature depends on, so it must be named rather than
    // folded into a count — naming it is the difference between this and the old row-count check.
    expect(out).toContain(onDisk[onDisk.length - 1]!);
    expect(out).not.toContain(PASS_SENTENCE);
    expect(status).toBe(1);
  });

  /** The real DSN with host and/or port swapped, rebuilt structurally rather than by regex. */
  function withHostPort(host: string, port: string): string {
    const s = REAL!;
    return `${s.scheme}://${s.userinfo === null ? '' : `${s.userinfo}@`}${host}:${port}${s.path}`;
  }

  it('REFUSES a DSN whose port has no container behind it', () => {
    // 5999 is outside every port this repo assigns. If something IS listening there, the
    // assertion fails loudly rather than passing for the wrong reason.
    const { status, out } = run(withHostPort(REAL!.host, '5999'));
    expect(out).toContain('no running container publishes port 5999');
    expect(out).not.toContain(PASS_SENTENCE);
    expect(status).toBe(1);
  });

  it('REFUSES a REMOTE host, even when the LOCAL box publishes that port', () => {
    // ⛔ THE PORT IS NOT THE ADDRESS. Every check the script performs goes through
    // `docker exec <container> psql`, and the container is found by published PORT ALONE. So a DSN
    // whose port matches a local container but whose HOST is somewhere else was fully certified —
    // measured: `…@10.255.255.1:<local port>/…` printed "73 applied, none missing" and
    // "Preflight passed", exit 0, while a real connection to that address hangs until the suite
    // times out. That is the original "vouching for a database the tests never open" defect with a
    // new hat on: it moved from "wrong container" to "right port, WRONG HOST".
    //
    // 10.255.255.1 is RFC1918 and unroutable here, and it deliberately reuses the port that DOES
    // resolve locally — so if the host check were removed this case would go green again.
    const { status, out } = run(withHostPort('10.255.255.1', REAL!.port));
    expect(out, 'the refusal must name the host it refused').toContain('10.255.255.1');
    expect(out).toContain('cannot verify a REMOTE database');
    // …and it must refuse BEFORE inspecting any local container, or it has already read the wrong
    // schema and merely declined to print the last line.
    expect(out).not.toContain('is published by container');
    expect(out).not.toContain('none missing from the tree');
    expect(out).not.toContain(PASS_SENTENCE);
    expect(status).toBe(1);
  });

  it('still ACCEPTS every spelling of "this machine"', () => {
    // The other half of the host check: a fix that refuses a remote host by refusing everything is
    // not a fix. Each of these resolves the same local container the real DSN does.
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0']) {
      const { out } = run(withHostPort(host, REAL!.port));
      expect(out, `${host} must be treated as local`).not.toContain('cannot verify a REMOTE');
      expect(out, `${host} must reach the container lookup`).toContain('is published by container');
    }
  });
});
