/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

import {BaseGoogleCredentialsConfig} from '../../src/tools/google_credentials.js';
import {
  GoogleTool,
  GoogleToolCall,
  GoogleToolStatus,
  authorizationRequiredMessage,
} from '../../src/tools/google_tool.js';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';
const FUNCTION_CALL_ID = 'test-function-call-id';
const HOUR_MS = 3600000;

const PARAMETERS = z.object({greeting: z.string()});

function createToolContext(state: Record<string, unknown> = {}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'test-user',
        state,
      }),
      pluginManager: new PluginManager([]),
    }),
    functionCallId: FUNCTION_CALL_ID,
  });
}

/** Non-user credentials that are already valid, so nothing is refreshed. */
function createValidCredentials(): OAuth2Client {
  const client = new OAuth2Client();
  client.setCredentials({
    access_token: 'access-token',
    expiry_date: Date.now() + HOUR_MS,
  });
  return client;
}

/** A tool that echoes everything its implementation was handed. */
function createEchoTool(
  options: {credentialsConfig?: BaseGoogleCredentialsConfig} = {},
) {
  return new GoogleTool<typeof PARAMETERS>({
    name: 'echo',
    description: 'Echoes its call.',
    parameters: PARAMETERS,
    execute: (input, call) => ({
      status: GoogleToolStatus.SUCCESS,
      greeting: input.greeting,
      accessToken: call.credentials?.credentials.access_token,
      userId: call.toolContext.userId,
    }),
    ...options,
  });
}

describe('GoogleTool', () => {
  it('runs the implementation without credentials when none are configured', async () => {
    const tool = createEchoTool();

    const result = await tool.runAsync({
      args: {greeting: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      greeting: 'hello',
      accessToken: undefined,
      userId: 'test-user',
    });
  });

  it('injects the resolved credentials into the call', async () => {
    const tool = createEchoTool({
      credentialsConfig: new BaseGoogleCredentialsConfig({
        credentials: createValidCredentials(),
      }),
    });

    const result = await tool.runAsync({
      args: {greeting: 'hi'},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({
      status: GoogleToolStatus.SUCCESS,
      accessToken: 'access-token',
    });
  });

  it('asks the end user for authorization when no credentials resolve', async () => {
    const toolContext = createToolContext();
    const tool = createEchoTool({
      credentialsConfig: new BaseGoogleCredentialsConfig({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        scopes: ['https://www.googleapis.com/auth/bigtable.data'],
      }),
    });

    const result = await tool.runAsync({args: {greeting: 'hi'}, toolContext});

    expect(result).toBe(authorizationRequiredMessage('echo'));
    expect(
      toolContext.actions.requestedAuthConfigs[FUNCTION_CALL_ID],
    ).toBeDefined();
  });

  it('reports a thrown failure as an error result instead of throwing', async () => {
    const tool = new GoogleTool({
      name: 'boom',
      description: 'Always fails.',
      execute: () => {
        throw new Error('backend unavailable');
      },
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      errorDetails: "Error in tool 'boom': backend unavailable",
    });
  });

  it('reports a schema violation as an error result', async () => {
    const tool = createEchoTool();

    const result = await tool.runAsync({
      args: {greeting: 42},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({status: GoogleToolStatus.ERROR});
  });

  it('keeps credentials out of the declaration', () => {
    const tool = createEchoTool({
      credentialsConfig: new BaseGoogleCredentialsConfig({
        credentials: createValidCredentials(),
      }),
    });

    const properties = tool._getDeclaration().parameters?.properties;

    expect(Object.keys(properties ?? {})).toEqual(['greeting']);
  });

  it('hands the implementation the context of the call', async () => {
    let seen: GoogleToolCall | undefined;
    const tool = new GoogleTool({
      name: 'inspect',
      description: 'Records its call.',
      execute: (_input, call) => {
        seen = call;
        return {status: GoogleToolStatus.SUCCESS};
      },
    });

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(seen?.toolContext.userId).toBe('test-user');
  });
});
