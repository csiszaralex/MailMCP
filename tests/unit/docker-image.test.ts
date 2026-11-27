import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// D39: .node-version is the one place for the Node version; the Dockerfile follows it.
const nodeVersion = readFileSync('.node-version', 'utf8').trim();
const dockerfile = readFileSync('Dockerfile', 'utf8');

/** The image of every FROM line, without a --platform or similar flag, in order. */
function fromImages(): { image: string; stage: string | undefined }[] {
  return [...dockerfile.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim)].map((m) => ({
    image: m[1] ?? '',
    stage: m[2],
  }));
}

describe('Dockerfile', () => {
  it('names the node image once, on the version in .node-version, pinned by digest', () => {
    const args = [...dockerfile.matchAll(/^ARG\s+NODE_IMAGE=(\S+)$/gm)].map((m) => m[1]);
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(
      new RegExp(`^node:${nodeVersion.replaceAll('.', '\\.')}-alpine[0-9.]*@sha256:[0-9a-f]{64}$`),
    );
    expect(dockerfile.match(/node:\d/g)).toHaveLength(1);
  });

  it('builds every stage on that image or on an earlier stage', () => {
    const stages: string[] = [];
    const froms = fromImages();
    expect(froms.length).toBeGreaterThan(0);
    for (const { image, stage } of froms) {
      expect(image === '${NODE_IMAGE}' || stages.includes(image)).toBe(true);
      if (stage !== undefined) stages.push(stage);
    }
  });
});
