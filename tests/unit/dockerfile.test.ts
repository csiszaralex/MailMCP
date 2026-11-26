import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// D39: .node-version is the one place for the Node version; the Dockerfile follows it.
const nodeVersion = readFileSync('.node-version', 'utf8').trim();
const dockerfile = readFileSync('Dockerfile', 'utf8');

describe('Dockerfile', () => {
  it('builds every node stage on the version in .node-version', () => {
    const images = [...dockerfile.matchAll(/^FROM\s+(node:\S+)/gm)].map((m) => m[1]);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image?.startsWith(`node:${nodeVersion}-alpine`)).toBe(true);
    }
  });
});
