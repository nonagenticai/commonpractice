// tests/config-flag-probe.ts — read a `config` boolean under a DIFFERENT environment than the one
// this suite was started with. NOT a `.test.ts` file: it declares no tests and is imported by
// seed-fabrication-guard.test.ts and seed-vote-fabrication-guard.test.ts.
//
// ⛔ WHY A SUBPROCESS. `src/config.ts` is a const evaluated ONCE at import, and the suite has
// already imported it under NODE_ENV=test. Mutating `process.env` afterwards changes nothing, and a
// test that did so would report a pass while observing the value it already had. A fresh process is
// the only honest way to ask "what would this flag be in production".
//
// Lives here rather than inside one of the two test files because a `.test.ts` cannot be imported
// by another `.test.ts` without bun registering — and running — its tests a second time.

/** Import `src/config` in a FRESH process under `env` and read `config[key]` back as a boolean. */
export async function flagUnder(
  env: Record<string, string>,
  key = 'seedFabricatedTelemetry',
): Promise<boolean> {
  const proc = Bun.spawn(
    ['bun', '-e', `console.log((await import("./src/config")).config.${key})`],
    {
      cwd: `${import.meta.dir}/..`,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const err = (await new Response(proc.stderr).text()).trim();
  await proc.exited;
  if (out !== 'true' && out !== 'false') {
    throw new Error(`config probe produced no boolean (stdout=${JSON.stringify(out)} stderr=${err})`);
  }
  return out === 'true';
}
