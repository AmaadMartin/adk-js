/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/eventarc/test_eventarc_toolset.py`, read at
 * `a3bd1115` on `main`. Each ported `it` keeps its Python name.
 *
 * `test_eventarc_tool_config_experimental_warning` is not ported:
 * `EventarcToolConfig` is a TypeScript interface, so there is no class to
 * decorate and no construction to warn on.
 */

import {
  cleanupClients,
  EventarcToolset,
  getLogger,
  type EventarcCredentialsConfig,
  type EventarcToolConfig,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  builtClients,
  resetEventarcFake,
  toolContext,
} from './eventarc_test_utils.js';

vi.mock('@google-cloud/eventarc-publishing', async () => {
  const {FakePublisherClient} = await import('./eventarc_test_utils.js');
  return {PublisherClient: FakePublisherClient};
});

const CREDENTIALS: EventarcCredentialsConfig = {
  credentials: {
    type: 'authorized_user',
    client_id: 'client1',
    client_secret: 'secret1',
    refresh_token: 'refresh1',
  },
};

describe('EventarcToolset', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
  });

  // The `experimental` decorator warns once per class, so this has to be the
  // first construction in the file.
  it('test_eventarc_toolset_experimental_warning', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});

    new EventarcToolset({credentialsConfig: CREDENTIALS});

    expect(warn).toHaveBeenCalledWith(
      'Class EventarcToolset is experimental and may change in the future.',
    );
    warn.mockRestore();
  });

  it('test_initializes_with_defaults', async () => {
    const toolset = new EventarcToolset({credentialsConfig: CREDENTIALS});

    expect(toolset.toolConfig).toEqual({});
    expect(toolset.credentialsConfig).toBe(CREDENTIALS);
    const tools = await toolset.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('publish_message');
  });

  it('test_initializes_with_explicit_configs', () => {
    const toolConfig: EventarcToolConfig = {projectId: 'test-project'};

    const toolset = new EventarcToolset({
      toolConfig,
      credentialsConfig: CREDENTIALS,
    });

    expect(toolset.toolConfig.projectId).toBe('test-project');
    expect(toolset.credentialsConfig).toBe(CREDENTIALS);
  });

  it('test_get_tools_returns_publish_message', async () => {
    const toolset = new EventarcToolset({credentialsConfig: CREDENTIALS});

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['publish_message']);
  });

  it('test_close_cleans_up_clients', async () => {
    const toolset = new EventarcToolset({
      toolConfig: {projectId: 'test-project'},
      credentialsConfig: CREDENTIALS,
    });
    const [tool] = await toolset.getTools();
    await tool.runAsync({
      args: {bus: 'bus', type: 'type', source: 'source'},
      toolContext: toolContext(),
    });
    expect(builtClients).toHaveLength(1);

    await toolset.close();

    expect(builtClients[0].closeCount).toBe(1);
  });
});
