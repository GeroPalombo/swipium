// Tool schemas under zod 4: the advertised JSON keeps its 2.x wire shape (src/lib/toolSchema.ts
// canonicalNode), argument errors keep their 2.x wording, and the schema-hash field descriptors are
// built from zod's public API with the same strings as before (so the hash did not move).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkToolArgs, strictToolSchema, toolInputJsonSchema } from '../src/lib/toolSchema.js';
import { describeZodField } from '../src/lib/schemaHash.js';

describe('toolInputJsonSchema', () => {
  const schema = strictToolSchema({
    sessionId: z.string().describe('Session.'),
    waitMs: z.number().int().min(0).optional().describe('Wait.'),
    budget: z.object({ maxActions: z.number().optional() }).optional(),
    fixtures: z.array(z.looseObject({ name: z.string() })).optional(),
    variables: z.record(z.string(), z.string()).optional(),
    cases: z.array(z.record(z.string(), z.any())).optional(),
    mode: z.enum(['a', 'b']).optional(),
  });
  const json = toolInputJsonSchema(schema) as {
    $schema?: string;
    additionalProperties?: unknown;
    required?: string[];
    properties: Record<string, Record<string, unknown>>;
  };
  const p = json.properties;

  it('is a closed draft-07 object without the $schema key', () => {
    expect(json.$schema).toBeUndefined();
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(['sessionId']);
  });

  it('puts description last and drops the implicit safe-integer bounds', () => {
    expect(Object.keys(p.sessionId)).toEqual(['type', 'description']);
    expect(p.waitMs).toEqual({ type: 'integer', minimum: 0, description: 'Wait.' });
    expect(Object.keys(p.waitMs).pop()).toBe('description');
  });

  it('closes nested objects, keeps loose objects open (true) and records as maps', () => {
    expect(p.budget).toEqual({ type: 'object', properties: { maxActions: { type: 'number' } }, additionalProperties: false });
    expect((p.fixtures.items as Record<string, unknown>).additionalProperties).toBe(true);
    expect(p.variables).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
    expect(p.cases.items).toEqual({ type: 'object', additionalProperties: {} });
  });
});

describe('checkToolArgs keeps the 2.x error wording', () => {
  const schema = strictToolSchema({
    s: z.string(),
    n: z.number().int().min(1).max(10).optional(),
    e: z.enum(['x', 'y']).optional(),
    l: z.literal('k').optional(),
    t: z.string().min(2).optional(),
    a: z.array(z.string()).max(1).optional(),
  });
  const messages = (args: unknown) => {
    const r = checkToolArgs(schema, args);
    return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
  };

  it('maps the common codes', () => {
    expect(messages({})).toEqual(['s: Required']);
    expect(messages({ s: 1 })).toEqual(['s: Expected string, received number']);
    expect(messages({ s: 'x', n: 1.5 })).toEqual(['n: Expected integer, received float']);
    expect(messages({ s: 'x', n: 0 })).toEqual(['n: Number must be greater than or equal to 1']);
    expect(messages({ s: 'x', n: 11 })).toEqual(['n: Number must be less than or equal to 10']);
    expect(messages({ s: 'x', e: 'z' })).toEqual(["e: Invalid enum value. Expected 'x' | 'y', received 'z'"]);
    expect(messages({ s: 'x', l: 'j' })).toEqual(['l: Invalid literal value, expected "k"']);
    expect(messages({ s: 'x', t: 'a' })).toEqual(['t: String must contain at least 2 character(s)']);
    expect(messages({ s: 'x', a: ['1', '2'] })).toEqual(['a: Array must contain at most 1 element(s)']);
    expect(messages([])).toEqual(['(arguments): Expected object, received array']);
  });
});

describe('describeZodField (schema-hash descriptors)', () => {
  it('produces the same descriptor strings as the zod 3 implementation', () => {
    expect(describeZodField(z.string())).toBe('string');
    expect(describeZodField(z.string().optional())).toBe('string?');
    expect(describeZodField(z.number().int().optional())).toBe('number?');
    expect(describeZodField(z.boolean().nullable())).toBe('boolean?');
    expect(describeZodField(z.enum(['b', 'a']).optional())).toBe('enum(a|b)?');
    expect(describeZodField(z.array(z.looseObject({ name: z.string() })).optional())).toBe('array<obj{name}>?');
    expect(describeZodField(z.record(z.string(), z.union([z.string(), z.boolean()])))).toBe('record<union(string|boolean)>');
    expect(describeZodField(z.array(z.record(z.string(), z.any())))).toBe('array<record<any>>');
    expect(describeZodField(z.object({ b: z.string(), a: z.number() }))).toBe('obj{a,b}');
    expect(describeZodField(z.string().default('x'))).toBe('string=def');
    expect(describeZodField('not a schema')).toBe('field');
  });
});
