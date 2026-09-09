/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BIGQUERY_TOKEN_CACHE_KEY,
  BigQueryCredentials,
  BigQueryTool,
  BigQueryToolExecute,
  isBigQueryTool,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {createToolContext} from './bigquery_test_utils.js';

const CREDENTIALS_CONFIG = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

const PARAMETERS = z.object({project_id: z.string()});

type Execute = BigQueryToolExecute<typeof PARAMETERS>;

function cached(refreshToken: string): BigQueryCredentials {
  return {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken,
  };
}

describe('isBigQueryTool', () => {
  it('recognises a BigQuery tool', () => {
    const tool = new BigQueryTool({
      name: 'noop',
      description: 'Does nothing.',
      parameters: PARAMETERS,
      execute: async () => 'ok',
    });

    expect(isBigQueryTool(tool)).toBe(true);
  });

  it.each([
    {label: 'undefined', value: undefined},
    {label: 'null', value: null},
    {label: 'a plain object', value: {name: 'noop'}},
  ])('rejects $label', ({value}) => {
    expect(isBigQueryTool(value)).toBe(false);
  });
});

describe('BigQueryTool without a credential configuration', () => {
  it('runs the implementation with no credential', async () => {
    const execute = vi.fn<Execute>(async () => 'done');
    const tool = new BigQueryTool({
      name: 'noop',
      description: 'Does nothing.',
      parameters: PARAMETERS,
      execute,
    });

    const result = await tool.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext(),
    });

    expect(result).toBe('done');
    expect(execute.mock.calls[0][1]).toBeUndefined();
  });
});

describe('BigQueryTool with a credential configuration', () => {
  function makeTool(execute: Execute) {
    return new BigQueryTool({
      name: 'list_things',
      description: 'Lists things.',
      parameters: PARAMETERS,
      execute,
      credentialsConfig: CREDENTIALS_CONFIG,
    });
  }

  it('hands the resolved credential to the implementation', async () => {
    const execute = vi.fn<Execute>(async () => 'done');
    const tool = makeTool(execute);

    const result = await tool.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext({
        state: {[BIGQUERY_TOKEN_CACHE_KEY]: cached('refresh-1')},
      }),
    });

    expect(result).toBe('done');
    expect(execute.mock.calls[0][1]).toEqual(cached('refresh-1'));
  });

  it('asks the user to authorize, and does not run, when there is no credential', async () => {
    const execute = vi.fn<Execute>(async () => 'done');
    const tool = makeTool(execute);
    const context = createToolContext({functionCallId: 'fc-9'});

    const result = await tool.runAsync({
      args: {project_id: 'p'},
      toolContext: context,
    });

    expect(result).toBe(
      'User authorization is required to access Google services for ' +
        'list_things. Please complete the authorization flow.',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(context.actions.requestedAuthConfigs['fc-9']).toBeDefined();
  });

  it('reports a throwing implementation as an error payload', async () => {
    const tool = makeTool(async () => {
      throw new Error('BigQuery said no');
    });

    const result = await tool.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext({
        state: {[BIGQUERY_TOKEN_CACHE_KEY]: cached('refresh-1')},
      }),
    });

    // No `Error in tool '<name>':` prefix, matching adk-python.
    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'BigQuery said no',
    });
  });

  it('keeps the HTTP status BigQuery reported in the error payload', async () => {
    // `FunctionTool.runAsync` rethrows a new Error carrying neither the cause
    // nor the status, so catching only there would drop the "(HTTP 403)".
    const tool = makeTool(async () => {
      throw Object.assign(new Error('Access Denied: Project p'), {code: 403});
    });

    const result = await tool.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext({
        state: {[BIGQUERY_TOKEN_CACHE_KEY]: cached('refresh-1')},
      }),
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Access Denied: Project p (HTTP 403)',
    });
  });

  it('reports an argument that does not match the schema as an error payload', async () => {
    // This failure happens before the `execute` adapter runs, so it is the
    // `runAsync` catch that turns it into a payload — hence the prefix.
    const execute = vi.fn<Execute>(async () => 'done');
    const tool = makeTool(execute);

    const result = await tool.runAsync({
      args: {project_id: 42},
      toolContext: createToolContext({
        state: {[BIGQUERY_TOKEN_CACHE_KEY]: cached('refresh-1')},
      }),
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect(result).toHaveProperty(
      'error_details',
      expect.stringContaining("Error in tool 'list_things':"),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('gives each concurrent call its own credential', async () => {
    // One tool instance serves every call, so a credential held on the
    // instance would leak from one caller to the other.
    const seen: Array<BigQueryCredentials | undefined> = [];
    const releases: Array<() => void> = [];
    const tool = makeTool(
      async (_input: unknown, credentials: BigQueryCredentials | undefined) => {
        seen.push(credentials);
        await new Promise<void>((resolve) => releases.push(resolve));
        return credentials?.refreshToken;
      },
    );

    const first = tool.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext({
        sessionId: 'session-a',
        state: {[BIGQUERY_TOKEN_CACHE_KEY]: cached('refresh-a')},
      }),
    });
    const second = tool.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext({
        sessionId: 'session-b',
        state: {[BIGQUERY_TOKEN_CACHE_KEY]: cached('refresh-b')},
      }),
    });

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases) {
      release();
    }

    await expect(first).resolves.toBe('refresh-a');
    await expect(second).resolves.toBe('refresh-b');
    expect(seen).toEqual([cached('refresh-a'), cached('refresh-b')]);
  });
});
