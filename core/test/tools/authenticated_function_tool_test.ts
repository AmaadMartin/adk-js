/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthenticatedFunctionTool,
  AuthRequiredResponse,
  AuthScheme,
  Context,
  createSession,
  InMemoryCredentialService,
  InvocationContext,
  LlmAgent,
  PENDING_AUTH_RESPONSE,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

const CREDENTIAL_KEY = 'test-credential-key';
const FUNCTION_CALL_ID = 'fc-1';

const apiKeyScheme: AuthScheme = {
  type: 'apiKey',
  name: 'X-Api-Key',
  in: 'header',
};

const apiKeyAuthConfig: AuthConfig = {
  credentialKey: CREDENTIAL_KEY,
  authScheme: apiKeyScheme,
};

const storedCredential: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'client-supplied-api-key',
};

const parameters = z.object({folder: z.string()});

/** A record of one call to the wrapped function. */
interface RecordedCall {
  input: {folder: string};
  toolContext?: Context;
  credential?: AuthCredential;
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
      credentialService: new InMemoryCredentialService(),
    }),
    functionCallId: FUNCTION_CALL_ID,
  });
}

/**
 * Builds a tool whose wrapped function records every argument it receives.
 */
function createRecordingTool(
  options: {
    authConfig?: AuthConfig;
    responseForAuthRequired?: AuthRequiredResponse;
  } = {},
): {tool: AuthenticatedFunctionTool<typeof parameters>; calls: RecordedCall[]} {
  const calls: RecordedCall[] = [];
  const tool = new AuthenticatedFunctionTool({
    name: 'list_items',
    description: 'Lists items.',
    parameters,
    execute: (input, toolContext, credential) => {
      calls.push({input, toolContext, credential});
      return `listed_${input.folder}`;
    },
    ...options,
  });

  return {tool, calls};
}

describe('AuthenticatedFunctionTool', () => {
  it('calls the function with an undefined credential when no auth config is set', async () => {
    const {tool, calls} = createRecordingTool();
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {folder: 'inbox'}, toolContext});

    expect(result).toBe('listed_inbox');
    expect(calls).toHaveLength(1);
    expect(calls[0].credential).toBeUndefined();
  });

  it('passes the resolved credential and the tool context to the function', async () => {
    const {tool, calls} = createRecordingTool({authConfig: apiKeyAuthConfig});
    const toolContext = createToolContext();
    toolContext.state.set(`temp:${CREDENTIAL_KEY}`, storedCredential);

    const result = await tool.runAsync({args: {folder: 'inbox'}, toolContext});

    expect(result).toBe('listed_inbox');
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({folder: 'inbox'});
    expect(calls[0].toolContext).toBe(toolContext);
    expect(calls[0].credential).toEqual(storedCredential);
  });

  it('works with a function that does not declare the credential parameter', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'list_items',
      description: 'Lists items.',
      parameters,
      authConfig: apiKeyAuthConfig,
      execute: ({folder}) => `listed_${folder}`,
    });
    const toolContext = createToolContext();
    toolContext.state.set(`temp:${CREDENTIAL_KEY}`, storedCredential);

    const result = await tool.runAsync({args: {folder: 'inbox'}, toolContext});

    expect(result).toBe('listed_inbox');
  });

  it('does not call the function and returns the pending response when no credential is available', async () => {
    const {tool, calls} = createRecordingTool({authConfig: apiKeyAuthConfig});
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {folder: 'inbox'}, toolContext});

    expect(result).toBe('Pending User Authorization.');
    expect(result).toBe(PENDING_AUTH_RESPONSE);
    expect(calls).toHaveLength(0);
    expect(
      toolContext.eventActions.requestedAuthConfigs[FUNCTION_CALL_ID],
    ).toEqual(apiKeyAuthConfig);
  });

  it('returns a custom responseForAuthRequired verbatim', async () => {
    const responseForAuthRequired = {status: 'auth_required'};
    const {tool, calls} = createRecordingTool({
      authConfig: apiKeyAuthConfig,
      responseForAuthRequired,
    });

    const result = await tool.runAsync({
      args: {folder: 'inbox'},
      toolContext: createToolContext(),
    });

    expect(result).toBe(responseForAuthRequired);
    expect(calls).toHaveLength(0);
  });

  it('validates the arguments against the zod schema before calling the function', async () => {
    const {tool, calls} = createRecordingTool();

    await expect(
      tool.runAsync({
        args: {folder: 42},
        toolContext: createToolContext(),
      }),
    ).rejects.toThrow("Error in tool 'list_items'");
    expect(calls).toHaveLength(0);
  });

  it('parses the arguments so the function receives the schema defaults', async () => {
    const calls: Array<{limit: number}> = [];
    const tool = new AuthenticatedFunctionTool({
      name: 'list_items',
      description: 'Lists items.',
      parameters: z.object({limit: z.number().default(10)}),
      execute: (input) => {
        calls.push(input);
        return 'ok';
      },
    });

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(calls[0]).toEqual({limit: 10});
  });

  it('does not expose credential as a declared parameter', () => {
    const {tool} = createRecordingTool({authConfig: apiKeyAuthConfig});

    const declaration = tool._getDeclaration();

    expect(declaration.parameters?.properties).toEqual({
      folder: {type: 'STRING'},
    });
    expect(declaration.parameters?.properties).not.toHaveProperty('credential');
  });

  it('wraps an error thrown by the function', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'list_items',
      description: 'Lists items.',
      parameters,
      authConfig: apiKeyAuthConfig,
      execute: () => {
        throw new Error('Function failed');
      },
    });
    const toolContext = createToolContext();
    toolContext.state.set(`temp:${CREDENTIAL_KEY}`, storedCredential);

    await expect(
      tool.runAsync({args: {folder: 'inbox'}, toolContext}),
    ).rejects.toThrow("Error in tool 'list_items': Function failed");
  });

  it('calls the function once the client has supplied the credential', async () => {
    const {tool, calls} = createRecordingTool({authConfig: apiKeyAuthConfig});
    const toolContext = createToolContext();

    const firstResult = await tool.runAsync({
      args: {folder: 'inbox'},
      toolContext,
    });
    expect(firstResult).toBe(PENDING_AUTH_RESPONSE);
    expect(calls).toHaveLength(0);

    // What the framework does with the client's auth response.
    toolContext.state.set(`temp:${CREDENTIAL_KEY}`, storedCredential);
    const secondResult = await tool.runAsync({
      args: {folder: 'inbox'},
      toolContext,
    });

    expect(secondResult).toBe('listed_inbox');
    expect(calls).toHaveLength(1);
    expect(calls[0].credential).toEqual(storedCredential);
  });
});
