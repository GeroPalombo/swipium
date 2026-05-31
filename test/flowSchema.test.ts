import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/flows/schema.js';

describe('flow schema', () => {
  it('parses a minimal public v1 flow', () => {
    const parsed = parseFlow(`
name: smoke
steps:
  - assertVisible: Home
  - tap: Start
  - screenshot: after-start
`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.flow?.name).toBe('smoke');
    expect(parsed.flow?.steps).toHaveLength(3);
  });
});
