/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ApiRegistry` runs the SecureConnect certificate provider through
 * `node:child_process`, and it is reachable from the package entry point. If it
 * touches that module while being imported, every test that partially mocks
 * `node:child_process` fails to import the package at all. Two dev CLI tests do
 * exactly that, and this pins the entry point against them.
 */

import {describe, expect, it, vi} from 'vitest';

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn(),
}));

describe('the package entry point under a partial node:child_process mock', () => {
  it('imports, and ApiRegistry is constructible', async () => {
    const {ApiRegistry} = await import('../../src/index.js');

    const registry = new ApiRegistry({projectId: 'p1'});

    expect(registry.projectId).toBe('p1');
    expect(registry.location).toBe('global');
  });
});
