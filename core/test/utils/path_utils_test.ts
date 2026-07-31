/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {isPathContained} from '../../src/utils/path_utils.js';

const root = path.resolve(path.sep, 'srv', 'data');

describe('isPathContained', () => {
  it('reports the root itself as contained', () => {
    expect(isPathContained(root, root)).toBe(true);
  });

  it('reports a direct child as contained', () => {
    expect(isPathContained(root, path.join(root, 'agent.yaml'))).toBe(true);
  });

  it('reports a nested child as contained', () => {
    expect(isPathContained(root, path.join(root, 'sub', 'agent.yaml'))).toBe(
      true,
    );
  });

  it('reports a path that walks out of the root as not contained', () => {
    expect(isPathContained(root, path.join(root, '..', 'agent.yaml'))).toBe(
      false,
    );
  });

  it('reports a sibling sharing the root name prefix as not contained', () => {
    expect(isPathContained(root, `${root}-old`)).toBe(false);
  });

  it('reports a sibling whose first segment starts with dots as contained', () => {
    expect(isPathContained(root, path.join(root, '..hidden', 'a.yaml'))).toBe(
      true,
    );
  });

  it('reports an unrelated absolute path as not contained', () => {
    expect(isPathContained(root, path.resolve(path.sep, 'etc', 'passwd'))).toBe(
      false,
    );
  });

  it('resolves relative arguments against the working directory', () => {
    expect(isPathContained('.', 'sub/agent.yaml')).toBe(true);
    expect(isPathContained('sub', '.')).toBe(false);
  });
});
