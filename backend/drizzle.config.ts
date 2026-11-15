import type { Config } from 'drizzle-kit';

export default {
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://commonpractice:commonpractice@localhost:5433/commonpractice',
  },
} satisfies Config;
