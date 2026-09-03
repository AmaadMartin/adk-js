/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  AuthenticatedFunctionTool,
  Context,
  InMemoryCredentialService,
  InvocationContext,
  LlmAgent,
  PENDING_USER_AUTHORIZATION,
  PluginManager,
  createSession,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v3';
import {logger} from '../../src/utils/logger.js';

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const AUTH_CODE_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://provider.example.com/authorize',
      tokenUrl: 'https://provider.example.com/token',
      scopes: {read: 'Read everything'},
    },
  },
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'secret',
};

/** A config whose credential is ready to use, so no client round trip runs. */
const READY_AUTH_CONFIG: AuthConfig = {
  credentialKey: 'ready',
  authScheme: API_KEY_SCHEME,
  rawAuthCredential: API_KEY_CREDENTIAL,
};

/** A config that needs the end user, so the tool asks the client. */
const CONSENT_AUTH_CONFIG: AuthConfig = {
  credentialKey: 'needs-consent',
  authScheme: AUTH_CODE_SCHEME,
  rawAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
  },
};

function makeContext(options?: {
  credentialService?: InMemoryCredentialService;
}): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    // A real agent instance, so the fixture breaks if InvocationContext's
    // contract changes rather than being silenced by a cast.
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
    credentialService: options?.credentialService,
  });
  return new Context({invocationContext, functionCallId: 'fc-1'});
}

/** The arguments a tool declaring a credential receives. */
interface LookupArgs {
  city: string;
  credential?: AuthCredential;
}

const CREDENTIAL_PARAMETERS = z.object({
  city: z.string(),
  credential: z.custom<AuthCredential>().optional(),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthenticatedFunctionTool without authentication', () => {
  it('runs a synchronous function', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'echo',
      description: 'Echoes the city.',
      parameters: z.object({city: z.string()}),
      execute: ({city}) => `sync ${city}`,
    });

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()}),
    ).resolves.toBe('sync Paris');
  });

  it('awaits an asynchronous function', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'echo',
      description: 'Echoes the city.',
      parameters: z.object({city: z.string()}),
      execute: async ({city}) => `async ${city}`,
    });

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()}),
    ).resolves.toBe('async Paris');
  });

  it('never asks the client for a credential', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'echo',
      description: 'Echoes the city.',
      parameters: z.object({city: z.string()}),
      execute: ({city}) => city,
    });
    const context = makeContext();

    await tool.runAsync({args: {city: 'Paris'}, toolContext: context});

    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('passes an undefined credential to a function that declares one', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'echo',
      description: 'Echoes the city.',
      parameters: CREDENTIAL_PARAMETERS,
      execute: ({credential}) => credential ?? 'no credential',
    });

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()}),
    ).resolves.toBe('no credential');
  });

  it('warns that a tool without an authConfig skips authentication', () => {
    const warn = vi.spyOn(logger, 'warn');

    new AuthenticatedFunctionTool({
      name: 'echo',
      description: 'Echoes the city.',
      execute: () => 'ok',
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skip authentication'),
    );
  });
});

describe('AuthenticatedFunctionTool with a resolved credential', () => {
  it('passes the credential to a synchronous function', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: READY_AUTH_CONFIG,
      execute: ({credential}) => credential?.apiKey,
    });

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()}),
    ).resolves.toBe('secret');
  });

  it('passes the credential to an asynchronous function', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: READY_AUTH_CONFIG,
      execute: async ({credential}) => credential?.apiKey,
    });

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()}),
    ).resolves.toBe('secret');
  });

  it('passes the tool context as the second argument', async () => {
    const context = makeContext();
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: READY_AUTH_CONFIG,
      execute: (_input, toolContext) => toolContext?.functionCallId,
    });

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: context}),
    ).resolves.toBe('fc-1');
  });

  it('adds the credential to the arguments and changes nothing else', async () => {
    const execute = vi.fn((_input: LookupArgs) => 'ok');
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: READY_AUTH_CONFIG,
      execute,
    });

    await tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()});

    expect(execute.mock.calls[0][0]).toEqual({
      city: 'Paris',
      credential: API_KEY_CREDENTIAL,
    });
  });

  it('replaces a credential the model supplied in the arguments', async () => {
    const execute = vi.fn((_input: LookupArgs) => 'ok');
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: READY_AUTH_CONFIG,
      execute,
    });

    await tool.runAsync({
      args: {
        city: 'Paris',
        credential: {authType: AuthCredentialTypes.API_KEY, apiKey: 'forged'},
      },
      toolContext: makeContext(),
    });

    expect(execute.mock.calls[0][0]).toEqual({
      city: 'Paris',
      credential: API_KEY_CREDENTIAL,
    });
  });

  it('omits the credential from a function that does not declare one', async () => {
    const execute = vi.fn((_input: LookupArgs) => 'ok');
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: z.object({city: z.string()}),
      authConfig: READY_AUTH_CONFIG,
      execute,
    });

    await tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()});

    expect(execute.mock.calls[0][0]).toEqual({city: 'Paris'});
  });

  it('omits the credential from a genai schema that does not declare one', async () => {
    const execute = vi.fn((_input: unknown) => 'ok');
    const parameters: Schema = {
      type: Type.OBJECT,
      properties: {city: {type: Type.STRING}},
      required: ['city'],
    };
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters,
      authConfig: READY_AUTH_CONFIG,
      execute,
    });

    await tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()});

    expect(execute.mock.calls[0][0]).toEqual({city: 'Paris'});
  });

  it('rejects with the message the function threw', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: READY_AUTH_CONFIG,
      execute: () => {
        throw new Error('upstream is down');
      },
    });

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()}),
    ).rejects.toThrow("Error in tool 'lookup': upstream is down");
  });

  it('reports an error when a required argument is missing', async () => {
    const execute = vi.fn((_input: LookupArgs) => 'ok');
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: READY_AUTH_CONFIG,
      execute,
    });

    // `FunctionTool` returns the missing-argument error to the model rather
    // than throwing it, so the model can retry with the argument.
    await expect(
      tool.runAsync({args: {}, toolContext: makeContext()}),
    ).resolves.toEqual({
      error:
        'Invoking `lookup()` failed as the following mandatory input parameters are not present:\n' +
        'city\n' +
        'You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('AuthenticatedFunctionTool without a credential', () => {
  it('returns the default pending response and asks the client', async () => {
    const execute = vi.fn((_input: LookupArgs) => 'ok');
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: CONSENT_AUTH_CONFIG,
      execute,
    });
    const context = makeContext();

    const response = await tool.runAsync({
      args: {city: 'Paris'},
      toolContext: context,
    });

    expect(response).toBe(PENDING_USER_AUTHORIZATION);
    expect(response).toBe('Pending User Authorization.');
    expect(execute).not.toHaveBeenCalled();
    expect(Object.keys(context.eventActions.requestedAuthConfigs)).toEqual([
      'fc-1',
    ]);
  });

  it('returns the configured response instead of the default', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: CONSENT_AUTH_CONFIG,
      responseForAuthRequired: {error: 'Please sign in to continue.'},
      execute: () => 'ok',
    });

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()}),
    ).resolves.toEqual({error: 'Please sign in to continue.'});
  });

  it('propagates a credential manager failure without running the function', async () => {
    const execute = vi.fn((_input: LookupArgs) => 'ok');
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      // An OAuth2 scheme with no raw credential cannot produce one.
      authConfig: {credentialKey: 'broken', authScheme: AUTH_CODE_SCHEME},
      execute,
    });

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: makeContext()}),
    ).rejects.toThrow(
      'rawAuthCredential is required for auth scheme type oauth2',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('AuthenticatedFunctionTool declaration', () => {
  it('reports the name and description', () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      execute: () => 'ok',
      authConfig: READY_AUTH_CONFIG,
    });

    const declaration = tool._getDeclaration();

    expect(declaration.name).toBe('lookup');
    expect(declaration.description).toBe('Looks up the city.');
  });

  it('hides the credential parameter from the model', () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: z.object({
        city: z.string(),
        credential: z.custom<AuthCredential>(),
      }),
      authConfig: READY_AUTH_CONFIG,
      execute: () => 'ok',
    });

    const parameters = tool._getDeclaration().parameters;

    expect(Object.keys(parameters?.properties ?? {})).toEqual(['city']);
    expect(parameters?.required).toEqual(['city']);
  });

  it('keeps a declaration that never mentioned the credential', () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: z.object({city: z.string()}),
      authConfig: READY_AUTH_CONFIG,
      execute: () => 'ok',
    });

    const parameters = tool._getDeclaration().parameters;

    expect(Object.keys(parameters?.properties ?? {})).toEqual(['city']);
    expect(parameters?.required).toEqual(['city']);
  });

  it('hides an optional credential from a schema with no required fields', () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: z.object({
        city: z.string().optional(),
        credential: z.custom<AuthCredential>().optional(),
      }),
      authConfig: READY_AUTH_CONFIG,
      execute: () => 'ok',
    });

    const parameters = tool._getDeclaration().parameters;

    expect(Object.keys(parameters?.properties ?? {})).toEqual(['city']);
    expect(parameters?.required).toBeUndefined();
  });

  it('does not modify a caller-supplied genai schema', () => {
    const parameters: Schema = {
      type: Type.OBJECT,
      properties: {
        city: {type: Type.STRING},
        credential: {type: Type.OBJECT},
      },
      required: ['city', 'credential'],
    };
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters,
      authConfig: READY_AUTH_CONFIG,
      execute: () => 'ok',
    });

    tool._getDeclaration();
    const declaration = tool._getDeclaration();

    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'city',
    ]);
    expect(declaration.parameters?.required).toEqual(['city']);
    expect(Object.keys(parameters.properties ?? {})).toEqual([
      'city',
      'credential',
    ]);
    expect(parameters.required).toEqual(['city', 'credential']);
  });

  it('leaves a schema with no properties alone', () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      authConfig: READY_AUTH_CONFIG,
      execute: () => 'ok',
    });

    expect(tool._getDeclaration().parameters).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });
});

describe('AuthenticatedFunctionTool with a credential service', () => {
  it('pauses for consent, then runs once the credential is stored', async () => {
    const credentialService = new InMemoryCredentialService();
    const execute = vi.fn(
      ({credential}: {credential?: AuthCredential}) =>
        credential?.oauth2?.accessToken,
    );
    const tool = new AuthenticatedFunctionTool({
      name: 'lookup',
      description: 'Looks up the city.',
      parameters: CREDENTIAL_PARAMETERS,
      authConfig: CONSENT_AUTH_CONFIG,
      execute,
    });

    const first = makeContext({credentialService});
    const pending = await tool.runAsync({
      args: {city: 'Paris'},
      toolContext: first,
    });

    expect(pending).toBe(PENDING_USER_AUTHORIZATION);
    expect(execute).not.toHaveBeenCalled();
    expect(first.eventActions.requestedAuthConfigs['fc-1']).toBeDefined();

    const granted: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'granted-token'},
    };
    const second = makeContext({credentialService});
    await credentialService.saveCredential(
      {...CONSENT_AUTH_CONFIG, exchangedAuthCredential: granted},
      second,
    );

    await expect(
      tool.runAsync({args: {city: 'Paris'}, toolContext: second}),
    ).resolves.toBe('granted-token');
    expect(second.eventActions.requestedAuthConfigs).toEqual({});
  });
});
