/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What `rag://` does when `@google/adk` does not give it a usable class.
 *
 * The mock swaps the export for every test in the file, so these cases live
 * apart from `service_registry_test.ts`, which needs a working stub.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  registerBuiltinServices,
  ServiceRegistry,
} from '../../src/cli/service_registry.js';

/** The value `@google/adk` exports as `VertexAiRagMemoryService`. */
const ragExport = vi.hoisted(() => ({value: undefined as unknown}));

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...actual,
    get VertexAiRagMemoryService(): unknown {
      return ragExport.value;
    },
  };
});

describe('rag:// class resolution', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
    registerBuiltinServices(registry);
    process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';
  });

  function createRagService(): Promise<unknown> {
    return registry.createMemoryService('rag://corpus-123', {
      agentsDir: '/path/to/agents',
    });
  }

  it('reports a missing export and names the alternative', async () => {
    ragExport.value = undefined;

    await expect(createRagService()).rejects.toThrowError(
      'rag:// needs VertexAiRagMemoryService, which the installed @google/adk' +
        ' does not export. Use agentengine:// for Agent Engine memory instead.',
    );
  });

  it('rejects an export that is not a memory service', async () => {
    ragExport.value = class NotAMemoryService {};

    await expect(createRagService()).rejects.toThrowError(
      'VertexAiRagMemoryService exported by @google/adk is not a memory service.',
    );
  });
});
