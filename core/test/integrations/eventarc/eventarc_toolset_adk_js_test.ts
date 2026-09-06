/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour the adk-js toolset has and adk-python does not: the tool-name
 * prefix, the tool filter, and the zod schema the model is shown. These have
 * no counterpart in
 * `tests/unittests/integrations/eventarc/test_eventarc_toolset.py`, so they
 * are kept apart from the ported tests.
 */

import {
  cleanupClients,
  createSession,
  EventarcToolset,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  type BaseTool,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {builtClients, resetEventarcFake} from './eventarc_test_utils.js';

vi.mock('@google-cloud/eventarc-publishing', async () => {
  const {FakePublisherClient} = await import('./eventarc_test_utils.js');
  return {PublisherClient: FakePublisherClient};
});

/** A context with just enough of an invocation for a tool filter to run. */
function readonlyContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  );
}

describe('EventarcToolset naming and filtering', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
  });

  it('prefixes the tool name when a prefix is given', async () => {
    const toolset = new EventarcToolset({prefix: 'ea'});

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['ea_publish_message']);
  });

  it('keeps a tool an array filter names', async () => {
    const toolset = new EventarcToolset({toolFilter: ['publish_message']});

    expect(await toolset.getTools()).toHaveLength(1);
  });

  it('drops a tool an array filter does not name', async () => {
    const toolset = new EventarcToolset({toolFilter: ['something_else']});

    expect(await toolset.getTools()).toEqual([]);
  });

  it('applies an array filter to the prefixed name', async () => {
    const toolset = new EventarcToolset({
      prefix: 'ea',
      toolFilter: ['publish_message'],
    });

    expect(await toolset.getTools()).toEqual([]);
  });

  it('asks a predicate filter about each tool', async () => {
    const seen: string[] = [];
    const toolset = new EventarcToolset({
      toolFilter: (tool: BaseTool) => {
        seen.push(tool.name);
        return false;
      },
    });

    const tools = await toolset.getTools(readonlyContext());

    expect(seen).toEqual(['publish_message']);
    expect(tools).toEqual([]);
  });

  it('keeps the tool a predicate filter accepts', async () => {
    const toolset = new EventarcToolset({
      toolFilter: (tool: BaseTool) => tool.name === 'publish_message',
    });

    expect(await toolset.getTools(readonlyContext())).toHaveLength(1);
  });

  it('returns every tool when a predicate filter has no context', async () => {
    const toolset = new EventarcToolset({toolFilter: () => false});

    expect(await toolset.getTools()).toHaveLength(1);
  });
});

describe('the publish_message tool declaration', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
  });

  it('shows the model every CloudEvent field, and no credentials', async () => {
    const [tool] = await new EventarcToolset().getTools();

    const declaration = tool._getDeclaration();

    expect(
      Object.keys(declaration?.parameters?.properties ?? {}).sort(),
    ).toEqual([
      'bus',
      'custom_attributes',
      'data',
      'datacontenttype',
      'id',
      'include_tracing_extension',
      'is_base64_encoded',
      'source',
      'specversion',
      'subject',
      'time',
      'type',
    ]);
    expect(declaration?.parameters?.required?.sort()).toEqual([
      'bus',
      'source',
      'type',
    ]);
  });

  it('binds the toolset credentials and project to the tool', async () => {
    const credentials = {
      client_email: 'test@test.com',
      private_key: 'key1',
    };
    const toolset = new EventarcToolset({
      toolConfig: {projectId: 'bound-project', publishTimeoutMs: 5_000},
      credentialsConfig: {credentials},
    });
    const [tool] = await toolset.getTools();

    await tool.runAsync({args: {bus: 'bus', type: 'type', source: 'source'}});

    expect(builtClients).toHaveLength(1);
    expect(builtClients[0].options?.projectId).toBe('bound-project');
    expect(builtClients[0].options?.credentials).toEqual(credentials);
    expect(builtClients[0].publishes[0].options?.timeout).toBe(5_000);
  });

  it('rejects an argument the schema does not allow', async () => {
    const [tool] = await new EventarcToolset().getTools();

    await expect(
      tool.runAsync({args: {bus: 'bus', type: 'type'}}),
    ).rejects.toThrow(/publish_message/);
  });
});
