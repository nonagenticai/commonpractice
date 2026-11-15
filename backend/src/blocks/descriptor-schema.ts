// src/blocks/descriptor-schema.ts — the canonical zod schema for a BlockDescriptor (typed I/O +
// capabilities + limits), shared by the block-authoring routes and the template write path so both
// validate an incoming descriptor identically. Mirrors the TS shapes in db/block-types.ts.
import { z } from 'zod';

export const fieldTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'json',
  'string[]',
  'enum',
  'dataset',
]);

export const fieldSpecSchema = z
  .object({
    type: fieldTypeSchema,
    required: z.boolean().optional(),
    enum: z.array(z.string()).optional(),
    pii: z.boolean().optional(),
    description: z.string().optional(),
    default: z.string().optional(),
    /** Display label for the port (the author's own words). The key stays the wire identifier.
     *  Other locales come from content_translations (blocks/port-labels.ts). */
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const descriptorSchema = z
  .object({
    inputs: z.record(z.string(), fieldSpecSchema),
    outputs: z.record(z.string(), fieldSpecSchema),
    capabilities: z
      .object({
        network: z.boolean().optional(),
        llm: z.boolean().optional(),
        /** Fabrication bit — user-visible ("Simulated"). See db/block-types.ts. */
        mockData: z.boolean().optional(),
        /**
         * ⛔ NOT OPTIONAL TO ADD HERE. `.strict()` REJECTS an unknown capability key, so a block
         * declaring the new `dataset` grant would fail save-time validation with no hint about why.
         * This is the gate `load-dataset` has to pass now that `dataset` and `mockData` are distinct
         * bits (access grant vs. fabrication claim).
         */
        dataset: z.boolean().optional(),
      })
      .strict(),
    limits: z
      .object({ timeoutMs: z.number().optional(), memMb: z.number().optional() })
      .strict()
      .optional(),
  })
  .strict();
