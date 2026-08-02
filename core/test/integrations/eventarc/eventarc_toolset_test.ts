/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
import {cleanupPublisherClients} from '../../../src/integrations/eventarc/client.js';
import {
  DEFAULT_PUBLISH_TIMEOUT_MS,
  resolvePublishTimeoutMs,
} from '../../../src/integrations/eventarc/config.js';
import {EventarcToolset} from '../../../src/integrations/eventarc/eventarc_toolset.js';
import {BaseTool} from '../../../src/tools/base_tool.js';
import {logger} from '../../../src/utils/logger.js';
import {createToolContext} from './eventarc_test_utils.js';

vi.mock('../../../src/integrations/eventarc/client.js', () => ({
  getPublisherClient: vi.fn(async () => ({
    publish: vi.fn(),
    close: vi.fn(),
  })),
  removePublisherClient: vi.fn(async () => {}),
  cleanupPublisherClients: vi.fn(async () => {}),
  loadPublisherClientCtor: vi.fn(async () => class {}),
}));

const CONTEXT: ReadonlyContext = createToolContext();

function toolNames(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EventarcToolset', () => {
  // The experimental decorator warns once per class, so this must be the first
  // test in the file to observe the warning.
  it('warns that the toolset is experimental on first construction', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    new EventarcToolset();

    expect(warnSpy).toHaveBeenCalledWith(
      'Class EventarcToolset is experimental and may change in the future.',
    );
    warnSpy.mockRestore();
  });

  it('applies empty configuration by default', () => {
    const toolset = new EventarcToolset();

    expect(toolset.toolConfig).toEqual({});
    expect(toolset.credentialsConfig).toEqual({});
    expect(resolvePublishTimeoutMs(toolset.toolConfig)).toBe(
      DEFAULT_PUBLISH_TIMEOUT_MS,
    );
  });

  it('retains explicit configuration', () => {
    const toolConfig = {projectId: 'test-project', publishTimeoutMs: 5_000};
    const credentialsConfig = {scopes: ['https://example.test/scope']};

    const toolset = new EventarcToolset({toolConfig, credentialsConfig});

    expect(toolset.toolConfig).toBe(toolConfig);
    expect(toolset.credentialsConfig).toBe(credentialsConfig);
  });

  it('exposes the prefix and tool filter to the base toolset', () => {
    const toolset = new EventarcToolset({
      prefix: 'orders',
      toolFilter: ['publish_message'],
    });

    expect(toolset.prefix).toBe('orders');
    expect(toolset.toolFilter).toEqual(['publish_message']);
  });

  it('returns only the generic publish tool by default', async () => {
    const toolset = new EventarcToolset();

    expect(toolNames(await toolset.getTools())).toEqual(['publish_message']);
  });

  it('filters the generic tool out when the filter excludes it', async () => {
    const toolset = new EventarcToolset({toolFilter: ['other_tool']});

    expect(toolNames(await toolset.getTools(CONTEXT))).toEqual([]);
    expect(toolNames(await toolset.getTools())).toEqual(['publish_message']);
  });

  it('keeps the generic tool when a predicate selects it', async () => {
    const toolset = new EventarcToolset({
      toolFilter: (tool) => tool.name === 'publish_message',
    });

    expect(toolNames(await toolset.getTools(CONTEXT))).toEqual([
      'publish_message',
    ]);
  });

  it('closes every cached publisher client', async () => {
    const toolset = new EventarcToolset();

    await toolset.close();

    expect(vi.mocked(cleanupPublisherClients)).toHaveBeenCalledOnce();
  });
});
