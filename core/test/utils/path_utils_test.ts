/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {resolveWithinDir} from '@google/adk';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

const BASE = path.resolve('/srv/project');

describe('resolveWithinDir', () => {
  it('resolves a relative path against the base directory', () => {
    expect(resolveWithinDir(BASE, 'tools/search.ts')).toBe(
      path.join(BASE, 'tools', 'search.ts'),
    );
  });

  it('resolves the base directory itself', () => {
    expect(resolveWithinDir(BASE, '.')).toBe(BASE);
  });

  it('accepts an absolute path inside the base directory', () => {
    const inside = path.join(BASE, 'agent.ts');

    expect(resolveWithinDir(BASE, inside)).toBe(inside);
  });

  it('resolves interior traversal that stays inside', () => {
    expect(resolveWithinDir(BASE, 'tools/../agent.ts')).toBe(
      path.join(BASE, 'agent.ts'),
    );
  });

  it('resolves a relative base against the working directory', () => {
    expect(resolveWithinDir('.', 'agent.ts')).toBe(
      path.join(process.cwd(), 'agent.ts'),
    );
  });

  it.each([['..'], ['../escape.ts'], ['a/../../escape.ts']])(
    'refuses the traversal %j',
    (filePath) => {
      expect(resolveWithinDir(BASE, filePath)).toBeUndefined();
    },
  );

  it('refuses an absolute path outside the base directory', () => {
    expect(resolveWithinDir(BASE, path.resolve('/etc/passwd'))).toBeUndefined();
  });

  it('refuses a sibling whose name merely shares the prefix', () => {
    expect(resolveWithinDir(BASE, `${BASE}_backup/secret.ts`)).toBeUndefined();
  });
});
