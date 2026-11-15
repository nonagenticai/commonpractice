-- 0001_init.sql — Session 0 baseline. Matches src/db/schema.ts (users + user_role).
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('employee', 'platform');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keycloak_sub    TEXT UNIQUE,
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  avatar_initials TEXT,
  role            user_role NOT NULL DEFAULT 'employee',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
