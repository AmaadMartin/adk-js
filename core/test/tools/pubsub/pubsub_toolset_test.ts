/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports adk-python `tests/unittests/tools/pubsub/test_pubsub_toolset.py`.
 * The `it` titles of the ported cases keep the Python test names so the two
 * suites stay greppable.
 */

import {BaseTool, isFunctionTool, ReadonlyContext} from '@google/adk';
import {PubSubToolset} from '@google/adk/tools/pubsub';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {getPublisherClient} from '../../../src/tools/pubsub/client.js';
import {
  makeToolContext,
  pubsubFake,
  testAuthClient,
  testCredentialsConfig,
} from './pubsub_test_utils.js';

vi.mock('@google-cloud/pubsub', async () => {
  const {fakePubSubModule} = await import('./pubsub_test_utils.js');
  return fakePubSubModule;
});

const ALL_TOOL_NAMES = [
  'publish_message',
  'pull_messages',
  'acknowledge_messages',
];

/** A toolset that authenticates as one identity for every end user. */
function makeToolset(toolFilter?: PubSubToolset['toolFilter']): PubSubToolset {
  return new PubSubToolset({
    credentialsConfig: testCredentialsConfig(),
    toolFilter,
  });
}

/** The names of the tools a toolset exposes, in order. */
async function toolNames(
  toolset: PubSubToolset,
  context?: ReadonlyContext,
): Promise<string[]> {
  return (await toolset.getTools(context)).map((tool) => tool.name);
}

beforeEach(() => {
  pubsubFake.reset();
});

afterEach(async () => {
  await new PubSubToolset({
    credentialsConfig: testCredentialsConfig(),
  }).close();
  vi.restoreAllMocks();
});

describe('PubSubToolset', () => {
  it('test_pubsub_toolset_tools_default', async () => {
    const tools = await makeToolset().getTools();

    expect(tools).toHaveLength(3);
    expect(tools.every((tool: BaseTool) => isFunctionTool(tool))).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual(ALL_TOOL_NAMES);
  });

  it.each([
    {id: 'None', selected: []},
    {id: 'publish', selected: ['publish_message']},
    {id: 'pull', selected: ['pull_messages']},
    {id: 'ack', selected: ['acknowledge_messages']},
  ])('test_pubsub_toolset_tools_selective: $id', async ({selected}) => {
    expect(await toolNames(makeToolset(selected))).toEqual(selected);
  });

  it.each([
    {id: 'all-unknown', selected: ['unknown'], returned: []},
    {
      id: 'mixed-known-unknown',
      selected: ['unknown', 'publish_message'],
      returned: ['publish_message'],
    },
  ])('test_pubsub_toolset_unknown_tool: $id', async ({selected, returned}) => {
    expect(await toolNames(makeToolset(selected))).toEqual(returned);
  });
});

describe('beyond the adk-python suite', () => {
  it('applies a name filter with a context too', async () => {
    const toolset = makeToolset(['pull_messages']);

    expect(await toolNames(toolset, makeToolContext())).toEqual([
      'pull_messages',
    ]);
  });

  it('applies a predicate filter when there is a context', async () => {
    const toolset = makeToolset((tool) => tool.name === 'publish_message');

    expect(await toolNames(toolset, makeToolContext())).toEqual([
      'publish_message',
    ]);
  });

  it('exposes every tool to a predicate filter with no context', async () => {
    const toolset = makeToolset(() => false);

    expect(await toolNames(toolset)).toEqual(ALL_TOOL_NAMES);
  });

  it('rejects a credentials config naming no credential source', () => {
    expect(() => new PubSubToolset({credentialsConfig: {}})).toThrow(
      'Must provide one of credentials, external_access_token_key, or' +
        ' client_id and client_secret pair.',
    );
  });

  it('rejects a credentials config naming two credential sources', () => {
    expect(
      () =>
        new PubSubToolset({
          credentialsConfig: {
            authClient: testAuthClient(),
            externalAccessTokenKey: 'pubsub_token',
          },
        }),
    ).toThrow(
      'If credentials are provided, external_access_token_key, client_id,' +
        ' client_secret, and scopes must not be provided.',
    );
  });

  it('closes the clients the tools opened', async () => {
    const toolset = makeToolset();
    await getPublisherClient({authClient: testAuthClient()});

    await toolset.close();

    expect(pubsubFake.closedPublishers).toBe(1);
  });
});
