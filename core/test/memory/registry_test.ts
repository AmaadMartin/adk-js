/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getMemoryServiceFromUri,
  InMemoryMemoryService,
  VertexAiMemoryBankService,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/**
 * `VertexAiMemoryBankService` warns when it is handed a resource name where an
 * id belongs, so the absence of the warning proves the URI was parsed into its
 * three parts rather than passed through whole.
 */
const RESOURCE_PATH_WARNING = 'appears to be a full resource path';

describe('getMemoryServiceFromUri', () => {
  const originalEnv = {...process.env};
  let warnings: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    process.env = {...originalEnv};
  });

  it('returns the in-memory service for memory://', () => {
    expect(getMemoryServiceFromUri('memory://')).toBeInstanceOf(
      InMemoryMemoryService,
    );
  });

  it('builds a memory bank service from a bare agent engine id', () => {
    process.env['GOOGLE_CLOUD_PROJECT'] = 'placeholder-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';

    const service = getMemoryServiceFromUri('agentengine://123');

    expect(service).toBeInstanceOf(VertexAiMemoryBankService);
    expect(warnings.join('')).not.toContain(RESOURCE_PATH_WARNING);
  });

  it('parses project, location and id out of the full resource name', () => {
    // Unset, so construction can only succeed if the URI supplied both.
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];

    const service = getMemoryServiceFromUri(
      'agentengine://projects/placeholder-project/locations/us-central1/reasoningEngines/456',
    );

    expect(service).toBeInstanceOf(VertexAiMemoryBankService);
    expect(warnings.join('')).not.toContain(RESOURCE_PATH_WARNING);
  });

  it.each([
    ['a rag corpus, which adk-js does not implement', 'rag://corpus-1'],
    ['an unknown scheme', 'redis://localhost:6379'],
    ['an agent engine id that is not numeric', 'agentengine://not-an-id'],
    [
      'an agent engine resource name missing its location',
      'agentengine://projects/placeholder-project/reasoningEngines/456',
    ],
  ])('rejects %s', (_name, uri) => {
    expect(() => getMemoryServiceFromUri(uri)).toThrow(
      `Unsupported memory service URI: ${uri}`,
    );
  });

  it('redacts the password of an unsupported URI', () => {
    expect(() =>
      getMemoryServiceFromUri('redis://user:hunter2@localhost:6379'),
    ).toThrow(
      'Unsupported memory service URI: redis://user:***@localhost:6379',
    );
  });
});
