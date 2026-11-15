// tests/setup-env.ts — set env BEFORE any module imports config. No imports here.
process.env.NODE_ENV ||= 'test';
process.env.AUTH_BYPASS ||= 'true';
// The suite runs under the PROD cadence: with no `cycle.cadence` row in the test DB the setting
// falls back to this bootstrap ('week'). Off-mode behaviour is tested by passing the setting/gate
// explicitly, never by flipping the global row under other files. Nothing in tests imports
// server.ts, so this never arms a scheduler.
process.env.CYCLE_ENABLED ||= 'true';
process.env.KEYCLOAK_URL ||= 'http://localhost:8080';
process.env.KEYCLOAK_REALM ||= 'portal';
process.env.DATABASE_URL ||=
  'postgresql://commonpractice:commonpractice@localhost:5433/commonpractice';
