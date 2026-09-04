/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/plugins/test_debug_logging_plugin.py`
 * at `main` (44e0b2a8b1215aa98f057c4a781ddc24bae220da).
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  BaseTool,
  Context,
  createEvent,
  createEventActions,
  createSession,
  DebugEntryType,
  DebugLoggingPlugin,
  DEFAULT_DEBUG_OUTPUT_PATH,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  OpenIdConnectWithConfig,
  PluginManager,
  Session,
} from '@google/adk';
import {Content, FinishReason, Language, Outcome} from '@google/genai';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {serializeContent} from '../../src/plugins/debug_logging_plugin.js';
import {Logger, resetLogger, setLogger} from '../../src/utils/logger.js';
import {safeSerialize} from '../../src/utils/redact_secrets.js';

const SENTINEL_ACCESS_TOKEN = 'sentinel-access-token-4f7a21';
const SENTINEL_REFRESH_TOKEN = 'sentinel-refresh-token-91cc03';
const SENTINEL_CLIENT_SECRET = 'sentinel-client-secret-b58d6e';
const SENTINEL_AUTH_CODE = 'sentinel-auth-code-2ad914';
const SENTINEL_CODE_VERIFIER = 'sentinel-code-verifier-7be055';
const SENTINEL_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nsentinel-key-body\n-----END PRIVATE KEY-----';

const REDACTED = '[REDACTED]';

/** POSIX file permissions differ on Windows, as they do for adk-python. */
const onPosix = process.platform !== 'win32';

let tempDir = '';
let outputFile = '';

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-debug-plugin-'));
  outputFile = path.join(tempDir, 'debug_output.yaml');
});

afterEach(async () => {
  resetLogger();
  await fs.rm(tempDir, {recursive: true, force: true});
});

/** An exchanged OAuth2 credential carrying sentinel secret values. */
function oauthCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'test-client-id',
      clientSecret: SENTINEL_CLIENT_SECRET,
      accessToken: SENTINEL_ACCESS_TOKEN,
      refreshToken: SENTINEL_REFRESH_TOKEN,
    },
  };
}

function makeSession(
  state: Record<string, unknown> = {key1: 'value1', key2: 123},
): Session {
  return createSession({
    id: 'test-session-id',
    appName: 'test-app',
    userId: 'test-user',
    state,
  });
}

function makeInvocationContext(
  session: Session,
  overrides: {invocationId?: string; agentName?: string; branch?: string} = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: overrides.invocationId ?? 'test-invocation-id',
    agent: new LlmAgent({name: overrides.agentName ?? 'test_agent'}),
    branch: overrides.branch,
    session,
    pluginManager: new PluginManager([]),
  });
}

function makeCallbackContext(invocationContext: InvocationContext): Context {
  return new Context({invocationContext});
}

function makeToolContext(invocationContext: InvocationContext): Context {
  return new Context({
    invocationContext,
    functionCallId: 'test-function-call-id',
  });
}

function makeTool(name: string): BaseTool {
  return new FunctionTool({
    name,
    description: `the ${name} tool`,
    execute: async () => ({ok: true}),
  });
}

function makeLogger(): {logger: Logger; messages: string[]} {
  const messages: string[] = [];
  const record = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  };
  return {
    logger: {
      setLogLevel: () => {},
      log: () => {},
      debug: record,
      info: record,
      warn: record,
      error: record,
    },
    messages,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Loads the written debug file as a list of YAML documents. */
async function readDocuments(
  file: string = outputFile,
): Promise<Array<Record<string, unknown>>> {
  const documents: Array<Record<string, unknown>> = [];
  for (const document of yaml.loadAll(await fs.readFile(file, 'utf-8'))) {
    if (!isRecord(document)) {
      expect.fail(`debug document is not a mapping: ${String(document)}`);
    }
    documents.push(document);
  }
  return documents;
}

/** Loads the single document the file is expected to hold. */
async function readDocument(
  file: string = outputFile,
): Promise<Record<string, unknown>> {
  const documents = await readDocuments(file);
  expect(documents).toHaveLength(1);
  return documents[0];
}

function listAt(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    expect.fail(`'${key}' is not a list`);
  }
  return value;
}

/** Walks a chain of mapping keys, failing the test at the first that is not. */
function at(
  record: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  let current = record;
  for (const key of keys) {
    const value = current[key];
    if (!isRecord(value)) {
      expect.fail(`'${key}' is not a mapping: ${String(value)}`);
    }
    current = value;
  }
  return current;
}

function entriesOf(
  document: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return listAt(document, 'entries').map((entry) => {
    if (!isRecord(entry)) {
      expect.fail(`entry is not a mapping: ${String(entry)}`);
    }
    return entry;
  });
}

function entriesOfType(
  document: Record<string, unknown>,
  entryType: DebugEntryType,
): Array<Record<string, unknown>> {
  return entriesOf(document).filter(
    (entry) => entry['entry_type'] === entryType,
  );
}

/** The `data` mapping of the single entry of the given kind. */
function onlyEntryData(
  document: Record<string, unknown>,
  entryType: DebugEntryType,
): Record<string, unknown> {
  const entries = entriesOfType(document, entryType);
  expect(entries).toHaveLength(1);
  return at(entries[0], 'data');
}

describe('TestDebugLoggingPluginInitialization', () => {
  it('test_default_initialization', async () => {
    const plugin = new DebugLoggingPlugin();

    expect(plugin.name).toBe('debug_logging_plugin');
    expect(DEFAULT_DEBUG_OUTPUT_PATH).toBe('adk_debug.yaml');
  });

  it('test_custom_initialization', async () => {
    const plugin = new DebugLoggingPlugin({
      name: 'custom_debug',
      outputPath: outputFile,
      includeSessionState: false,
      includeSystemInstruction: false,
    });
    const invocationContext = makeInvocationContext(makeSession());
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [],
      config: {systemInstruction: 'Full system instruction text'},
      liveConnectConfig: {},
      toolsDict: {},
    };

    expect(plugin.name).toBe('custom_debug');

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext: makeCallbackContext(invocationContext),
      llmRequest,
    });
    await plugin.afterRunCallback({invocationContext});

    const document = await readDocument();
    expect(
      entriesOfType(document, DebugEntryType.SESSION_STATE_SNAPSHOT),
    ).toHaveLength(0);
    const config = at(
      onlyEntryData(document, DebugEntryType.LLM_REQUEST),
      'config',
    );
    expect(config['system_instruction']).toBeUndefined();
    expect(config['system_instruction_length']).toBe(28);
  });
});

describe('TestDebugLoggingPluginCallbacks', () => {
  let plugin: DebugLoggingPlugin;
  let session: Session;
  let invocationContext: InvocationContext;

  beforeEach(() => {
    plugin = new DebugLoggingPlugin({outputPath: outputFile});
    session = makeSession();
    invocationContext = makeInvocationContext(session);
  });

  it('test_before_run_callback_initializes_state', async () => {
    const result = await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    expect(result).toBeUndefined();
    const document = await readDocument();
    expect(document['invocation_id']).toBe('test-invocation-id');
    expect(document['session_id']).toBe('test-session-id');
    const entries = entriesOf(document);
    expect(entries[0]['entry_type']).toBe(DebugEntryType.INVOCATION_START);
    expect(
      entriesOfType(document, DebugEntryType.INVOCATION_START),
    ).toHaveLength(1);
  });

  it('test_on_user_message_callback_logs_message', async () => {
    await plugin.beforeRunCallback({invocationContext});

    const userMessage: Content = {
      role: 'user',
      parts: [{text: 'Hello, world!'}],
    };
    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });
    await plugin.afterRunCallback({invocationContext});

    expect(result).toBeUndefined();
    const data = onlyEntryData(
      await readDocument(),
      DebugEntryType.USER_MESSAGE,
    );
    const content = at(data, 'content');
    expect(content['role']).toBe('user');
    expect(listAt(content, 'parts')[0]).toEqual({text: 'Hello, world!'});
  });

  it('test_before_model_callback_logs_request', async () => {
    await plugin.beforeRunCallback({invocationContext});

    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [{role: 'user', parts: [{text: 'Test prompt'}]}],
      config: {systemInstruction: 'You are a helpful assistant.'},
      liveConnectConfig: {},
      toolsDict: {},
    };
    const result = await plugin.beforeModelCallback({
      callbackContext: makeCallbackContext(invocationContext),
      llmRequest,
    });
    await plugin.afterRunCallback({invocationContext});

    expect(result).toBeUndefined();
    const data = onlyEntryData(
      await readDocument(),
      DebugEntryType.LLM_REQUEST,
    );
    expect(data['model']).toBe('gemini-2.5-flash');
    expect(data['content_count']).toBe(1);
    expect(at(data, 'config')['system_instruction']).toBe(
      'You are a helpful assistant.',
    );
  });

  it('test_after_model_callback_logs_response', async () => {
    await plugin.beforeRunCallback({invocationContext});

    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'Hello! How can I help?'}]},
      turnComplete: true,
    };
    const result = await plugin.afterModelCallback({
      callbackContext: makeCallbackContext(invocationContext),
      llmResponse,
    });
    await plugin.afterRunCallback({invocationContext});

    expect(result).toBeUndefined();
    const data = onlyEntryData(
      await readDocument(),
      DebugEntryType.LLM_RESPONSE,
    );
    expect(data['turn_complete']).toBe(true);
    expect(at(data, 'content')['role']).toBe('model');
  });

  it('test_before_tool_callback_logs_tool_call', async () => {
    await plugin.beforeRunCallback({invocationContext});

    const result = await plugin.beforeToolCallback({
      tool: makeTool('test_tool'),
      toolArgs: {param1: 'value1', param2: 42},
      toolContext: makeToolContext(invocationContext),
    });
    await plugin.afterRunCallback({invocationContext});

    expect(result).toBeUndefined();
    const data = onlyEntryData(await readDocument(), DebugEntryType.TOOL_CALL);
    expect(data['tool_name']).toBe('test_tool');
    expect(at(data, 'args')['param1']).toBe('value1');
    expect(at(data, 'args')['param2']).toBe(42);
  });

  it('test_after_tool_callback_logs_tool_response', async () => {
    await plugin.beforeRunCallback({invocationContext});

    const result = await plugin.afterToolCallback({
      tool: makeTool('test_tool'),
      toolArgs: {param1: 'value1'},
      toolContext: makeToolContext(invocationContext),
      result: {output: 'success', data: [1, 2, 3]},
    });
    await plugin.afterRunCallback({invocationContext});

    expect(result).toBeUndefined();
    const data = onlyEntryData(
      await readDocument(),
      DebugEntryType.TOOL_RESPONSE,
    );
    expect(data['tool_name']).toBe('test_tool');
    expect(at(data, 'result')['output']).toBe('success');
  });

  it('test_on_event_callback_logs_event', async () => {
    await plugin.beforeRunCallback({invocationContext});

    const event = createEvent({
      author: 'test-agent',
      content: {role: 'model', parts: [{text: 'Response text'}]},
    });
    const result = await plugin.onEventCallback({invocationContext, event});
    await plugin.afterRunCallback({invocationContext});

    expect(result).toBeUndefined();
    const document = await readDocument();
    const data = onlyEntryData(document, DebugEntryType.EVENT);
    expect(data['author']).toBe('test-agent');
    expect(data['event_id']).toBe(event.id);
  });

  it('test_on_model_error_callback_logs_error', async () => {
    await plugin.beforeRunCallback({invocationContext});

    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    const error = new TypeError('Test error message');
    const result = await plugin.onModelErrorCallback({
      callbackContext: makeCallbackContext(invocationContext),
      llmRequest,
      error,
    });
    await plugin.afterRunCallback({invocationContext});

    expect(result).toBeUndefined();
    const data = onlyEntryData(await readDocument(), DebugEntryType.LLM_ERROR);
    expect(data['error_type']).toBe('TypeError');
    expect(data['error_message']).toBe('Test error message');
  });

  it('test_on_tool_error_callback_logs_error', async () => {
    await plugin.beforeRunCallback({invocationContext});

    const error = new RangeError('Tool execution failed');
    const result = await plugin.onToolErrorCallback({
      tool: makeTool('test_tool'),
      toolArgs: {param1: 'value1'},
      toolContext: makeToolContext(invocationContext),
      error,
    });
    await plugin.afterRunCallback({invocationContext});

    expect(result).toBeUndefined();
    const data = onlyEntryData(await readDocument(), DebugEntryType.TOOL_ERROR);
    expect(data['tool_name']).toBe('test_tool');
    expect(data['error_type']).toBe('RangeError');
  });
});

describe('TestDebugLoggingPluginFileOutput', () => {
  it('test_after_run_callback_writes_to_file', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.beforeRunCallback({invocationContext});
    await plugin.onUserMessageCallback({
      invocationContext,
      userMessage: {role: 'user', parts: [{text: 'Test message'}]},
    });
    await plugin.afterRunCallback({invocationContext});

    const document = await readDocument();
    expect(document['invocation_id']).toBe('test-invocation-id');
    expect(document['session_id']).toBe('test-session-id');
    expect(entriesOf(document).length).toBeGreaterThanOrEqual(2);
  });

  it('test_after_run_callback_includes_session_state', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath: outputFile,
      includeSessionState: true,
    });
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    const data = onlyEntryData(
      await readDocument(),
      DebugEntryType.SESSION_STATE_SNAPSHOT,
    );
    expect(at(data, 'state')['key1']).toBe('value1');
  });

  it('test_after_run_callback_excludes_session_state_when_disabled', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath: outputFile,
      includeSessionState: false,
    });
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    expect(
      entriesOfType(
        await readDocument(),
        DebugEntryType.SESSION_STATE_SNAPSHOT,
      ),
    ).toHaveLength(0);
  });

  it('test_multiple_invocations_append_to_file', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const session = makeSession();

    for (const invocationId of ['invocation-1', 'invocation-2']) {
      const invocationContext = makeInvocationContext(session, {invocationId});
      await plugin.beforeRunCallback({invocationContext});
      await plugin.afterRunCallback({invocationContext});
    }

    const documents = await readDocuments();
    expect(documents).toHaveLength(2);
    expect(documents[0]['invocation_id']).toBe('invocation-1');
    expect(documents[1]['invocation_id']).toBe('invocation-2');
  });

  it('test_after_run_callback_cleans_up_state', async () => {
    const {logger, messages} = makeLogger();
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});
    setLogger(logger);
    await plugin.afterRunCallback({invocationContext});

    // The state is gone, so the second write finds nothing to write.
    expect(await readDocuments()).toHaveLength(1);
    expect(messages).toContain(
      'No debug state for invocation test-invocation-id, skipping write',
    );
  });
});

describe('TestDebugLoggingPluginSerialization', () => {
  it('test_serialize_content_with_text', () => {
    const result = serializeContent({role: 'user', parts: [{text: 'Hello'}]});

    expect(result).toEqual({role: 'user', parts: [{text: 'Hello'}]});
  });

  it('test_serialize_content_with_function_call', () => {
    const result = serializeContent({
      role: 'model',
      parts: [
        {functionCall: {id: 'fc-1', name: 'test_func', args: {arg1: 'val1'}}},
      ],
    });

    expect(result).toEqual({
      role: 'model',
      parts: [
        {function_call: {id: 'fc-1', name: 'test_func', args: {arg1: 'val1'}}},
      ],
    });
  });

  it('test_serialize_content_with_none', () => {
    expect(serializeContent(undefined)).toBeUndefined();
  });

  it('test_safe_serialize_handles_bytes', () => {
    expect(safeSerialize(new TextEncoder().encode('binary data'))).toBe(
      '<bytes: 11 bytes>',
    );
  });

  it('test_safe_serialize_handles_nested_structures', () => {
    const result = safeSerialize({
      list: [1, 2, {nested: 'value'}],
      set: new Set([3, 4]),
      string: 'text',
    });

    expect(result).toEqual({
      list: [1, 2, {nested: 'value'}],
      // A Python tuple becomes a list; the closest adk-js shape is a Set.
      set: [3, 4],
      string: 'text',
    });
  });
});

describe('TestDebugLoggingPluginRedaction', () => {
  it('test_session_state_credential_model_is_redacted', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(
      makeSession({
        'key1': 'value1',
        'temp:oauth2_credential': oauthCredential(),
      }),
    );

    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    const raw = await fs.readFile(outputFile, 'utf-8');
    expect(raw).not.toContain(SENTINEL_ACCESS_TOKEN);
    expect(raw).not.toContain(SENTINEL_REFRESH_TOKEN);
    expect(raw).not.toContain(SENTINEL_CLIENT_SECRET);

    const state = at(
      onlyEntryData(
        await readDocument(),
        DebugEntryType.SESSION_STATE_SNAPSHOT,
      ),
      'state',
    );
    expect(state['temp:oauth2_credential']).toBe(REDACTED);
    // Non-credential state is still useful for debugging.
    expect(state['key1']).toBe('value1');
  });

  it('test_session_state_credential_dict_is_redacted', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(
      makeSession({
        'temp:oauth2_credential': {
          oauth2: {'access_token': SENTINEL_ACCESS_TOKEN},
        },
        'user:profile': {
          name: 'test-user',
          'refresh_token': SENTINEL_REFRESH_TOKEN,
        },
      }),
    );

    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    const raw = await fs.readFile(outputFile, 'utf-8');
    expect(raw).not.toContain(SENTINEL_ACCESS_TOKEN);
    expect(raw).not.toContain(SENTINEL_REFRESH_TOKEN);

    const state = at(
      onlyEntryData(
        await readDocument(),
        DebugEntryType.SESSION_STATE_SNAPSHOT,
      ),
      'state',
    );
    expect(state['temp:oauth2_credential']).toBe(REDACTED);
    expect(at(state, 'user:profile')['refresh_token']).toBe(REDACTED);
    expect(at(state, 'user:profile')['name']).toBe('test-user');
  });

  it('test_state_delta_credential_is_redacted', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());
    await plugin.beforeRunCallback({invocationContext});

    const event = createEvent({
      author: 'test-agent',
      actions: createEventActions({
        stateDelta: {
          'temp:oauth2_credential': oauthCredential(),
          'counter': 7,
        },
      }),
    });

    await plugin.onEventCallback({invocationContext, event});
    await plugin.afterRunCallback({invocationContext});

    const stateDelta = at(
      onlyEntryData(await readDocument(), DebugEntryType.EVENT),
      'actions',
      'state_delta',
    );
    expect(stateDelta['temp:oauth2_credential']).toBe(REDACTED);
    expect(stateDelta['counter']).toBe(7);
  });

  it('test_credential_nested_in_non_credential_model_is_redacted', () => {
    const result = safeSerialize({
      label: 'anything',
      payload: oauthCredential(),
    });

    expect(result).toEqual({label: 'anything', payload: REDACTED});
  });

  it('test_credential_in_container_under_arbitrary_key_is_redacted', () => {
    const result = safeSerialize({
      'some_users_own_key': [
        {inner: [oauthCredential(), 'keep-me']},
        {label: 'deep', payload: oauthCredential()},
      ],
    });

    expect(result).toEqual({
      'some_users_own_key': [
        {inner: [REDACTED, 'keep-me']},
        {label: 'deep', payload: REDACTED},
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_CLIENT_SECRET);
  });

  it('test_carrier_fields_are_normalized_to_yaml_safe_values', () => {
    const result = safeSerialize({
      kind: AuthCredentialTypes.OAUTH2,
      // Divergence: timestamps are UTC here, where adk-python writes naive
      // local time.
      issuedAt: new Date('2026-01-02T03:04:05.000Z'),
      payload: oauthCredential(),
    });

    expect(result).toEqual({
      kind: 'oauth2',
      issuedAt: '2026-01-02T03:04:05.000Z',
      payload: REDACTED,
    });
    expect(yaml.load(yaml.dump(result))).toEqual(result);
  });

  it('test_auth_config_serializes_to_loadable_yaml', () => {
    const authScheme: OpenIdConnectWithConfig = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/openid-configuration',
      authorizationEndpoint: 'https://example.com/auth',
      tokenEndpoint: 'https://example.com/token',
      scopes: ['openid'],
    };
    const authConfig: AuthConfig = {
      authScheme,
      rawAuthCredential: oauthCredential(),
      credentialKey: 'test-credential-key',
    };

    const result = safeSerialize(authConfig);

    if (!isRecord(result)) {
      expect.fail('serialized AuthConfig is not a mapping');
    }
    expect(result['rawAuthCredential']).toBe(REDACTED);
    // adk-python's pydantic alias is `type_`; the adk-js field is `type`.
    expect(at(result, 'authScheme')['type']).toBe('openIdConnect');
    expect(yaml.load(yaml.dump(result))).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ACCESS_TOKEN);
  });

  it('test_self_referential_value_is_bounded', () => {
    const carrier: Record<string, unknown> = {
      label: 'loop',
      payload: oauthCredential(),
    };
    carrier['parent'] = carrier;
    const cyclicDict: Record<string, unknown> = {
      credential: oauthCredential(),
    };
    cyclicDict['itself'] = cyclicDict;

    const fromCarrier = safeSerialize(carrier);
    const fromDict = safeSerialize(cyclicDict);

    if (!isRecord(fromCarrier) || !isRecord(fromDict)) {
      expect.fail('a bounded walk must still produce a mapping');
    }
    expect(fromCarrier['payload']).toBe(REDACTED);
    expect(fromDict['credential']).toBe(REDACTED);
    for (const result of [fromCarrier, fromDict]) {
      expect(yaml.load(yaml.dump(result))).toEqual(result);
      expect(JSON.stringify(result)).not.toContain(SENTINEL_ACCESS_TOKEN);
    }
  });

  it('test_hyphenated_sensitive_keys_are_redacted', () => {
    const result = safeSerialize({
      headers: {
        'X-Api-Key': SENTINEL_CLIENT_SECRET,
        'Proxy-Authorization': SENTINEL_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    expect(result).toEqual({
      headers: {
        'X-Api-Key': REDACTED,
        'Proxy-Authorization': REDACTED,
        'Content-Type': 'application/json',
      },
    });
  });

  it('test_oauth_authorization_code_keys_are_redacted', () => {
    const result = safeSerialize({
      'apikey_scheme_existing_exchanged_credential': {
        oauth2: {
          'auth_code': SENTINEL_AUTH_CODE,
          'auth_response_uri': `https://x/cb?code=${SENTINEL_AUTH_CODE}`,
          'code_verifier': SENTINEL_CODE_VERIFIER,
          'client_id': 'test-client-id',
        },
      },
    });

    if (!isRecord(result)) {
      expect.fail('serialized payload is not a mapping');
    }
    const oauth2 = at(
      result,
      'apikey_scheme_existing_exchanged_credential',
      'oauth2',
    );
    expect(oauth2['auth_code']).toBe(REDACTED);
    expect(oauth2['auth_response_uri']).toBe(REDACTED);
    expect(oauth2['code_verifier']).toBe(REDACTED);
    expect(oauth2['client_id']).toBe('test-client-id');
  });

  it('test_scoped_state_keys_are_redacted', () => {
    const result = safeSerialize({
      'api_key': SENTINEL_CLIENT_SECRET,
      'user:api_key': SENTINEL_CLIENT_SECRET,
      'app:client_secret': SENTINEL_CLIENT_SECRET,
      'user:profile': {name: 'test-user'},
    });

    expect(result).toEqual({
      'api_key': REDACTED,
      'user:api_key': REDACTED,
      'app:client_secret': REDACTED,
      'user:profile': {name: 'test-user'},
    });
  });

  it('test_key_spelling_variants_are_redacted', () => {
    const result = safeSerialize({
      'apiKey': SENTINEL_CLIENT_SECRET,
      'secret_key': SENTINEL_CLIENT_SECRET,
      'bearer_token': SENTINEL_ACCESS_TOKEN,
      'credentials': SENTINEL_CLIENT_SECRET,
      'serviceAccountCredentials': SENTINEL_CLIENT_SECRET,
    });

    if (!isRecord(result)) {
      expect.fail('serialized payload is not a mapping');
    }
    expect(new Set(Object.values(result))).toEqual(new Set([REDACTED]));
  });

  it('test_usage_counters_survive_key_matching', () => {
    const result = safeSerialize({
      'usage_metadata': {
        'prompt_token_count': 12,
        'candidates_token_count': 34,
        'total_token_count': 46,
      },
      'max_output_tokens': 1024,
      'cache_key': 'abc',
    });

    expect(result).toEqual({
      'usage_metadata': {
        'prompt_token_count': 12,
        'candidates_token_count': 34,
        'total_token_count': 46,
      },
      'max_output_tokens': 1024,
      'cache_key': 'abc',
    });
  });

  it('test_private_key_in_a_string_value_is_redacted', () => {
    const result = safeSerialize({
      'user:uploaded_file':
        `{"type": "service_account", "client_email": "a@b.example.com",` +
        ` "private_key": "${SENTINEL_PRIVATE_KEY}"}`,
      'notes': ['harmless', SENTINEL_PRIVATE_KEY],
    });

    if (!isRecord(result)) {
      expect.fail('serialized payload is not a mapping');
    }
    expect(result['notes']).toEqual(['harmless', REDACTED]);
    expect(JSON.stringify(result)).not.toContain('sentinel-key-body');
  });

  it('test_only_the_private_key_block_is_cut_from_the_string', () => {
    expect(
      safeSerialize(`here is my key ${SENTINEL_PRIVATE_KEY} please rotate it`),
    ).toBe(`here is my key ${REDACTED} please rotate it`);
  });

  it('test_armor_header_variants_are_redacted', () => {
    const result = safeSerialize({
      pgp:
        '-----BEGIN PGP PRIVATE KEY BLOCK-----\nsentinel-key-body\n' +
        '-----END PGP PRIVATE KEY BLOCK-----',
      rsa:
        '-----BEGIN RSA PRIVATE KEY-----\nsentinel-key-body\n' +
        '-----END RSA PRIVATE KEY-----',
      unterminated: '-----BEGIN PRIVATE KEY-----\nsentinel-key-body\n',
    });

    if (!isRecord(result)) {
      expect.fail('serialized payload is not a mapping');
    }
    expect(new Set(Object.values(result))).toEqual(new Set([REDACTED]));
  });

  it('test_prose_quoting_armor_fragments_is_kept', () => {
    const prose = 'notes about a PRIVATE KEY----- and -----BEGIN elsewhere';

    expect(safeSerialize(prose)).toBe(prose);
  });

  it('test_none_and_scalars_pass_through_unchanged', () => {
    expect(safeSerialize(undefined)).toBeNull();
    expect(safeSerialize('plain')).toBe('plain');
    expect(safeSerialize(7)).toBe(7);
  });

  it('test_a_secret_nested_in_a_list_is_redacted', () => {
    expect(safeSerialize([null, {token: SENTINEL_ACCESS_TOKEN}])).toEqual([
      null,
      {token: REDACTED},
    ]);
  });

  it('test_the_walk_depth_bound_truncates_instead_of_recursing', () => {
    let deep: unknown = {'api_key': SENTINEL_CLIENT_SECRET};
    for (let i = 0; i < 60; i++) {
      deep = {level: deep};
    }

    const result = JSON.stringify(safeSerialize(deep));

    // Divergence: adk-python labels the bound `<dict ...>`; this is the JS
    // type name for the same value.
    expect(result).toContain('<Object ...>');
    expect(result).not.toContain(SENTINEL_CLIENT_SECRET);
  });

  it('test_non_credential_values_are_not_redacted', () => {
    const result = safeSerialize({
      nested: {list: [1, 'two', {deep: 'value'}]},
      model: {id: 'fc-1', name: 'do_it', args: {a: 1}},
    });

    expect(result).toEqual({
      nested: {list: [1, 'two', {deep: 'value'}]},
      model: {id: 'fc-1', name: 'do_it', args: {a: 1}},
    });
  });

  it.skipIf(!onPosix)('test_output_file_is_not_world_readable', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    const {mode} = await fs.stat(outputFile);
    expect(mode & 0o077).toBe(0);
  });

  it.skipIf(!onPosix)(
    'test_pre_existing_world_readable_file_is_flagged',
    async () => {
      await fs.writeFile(outputFile, '');
      await fs.chmod(outputFile, 0o644);
      const {logger, messages} = makeLogger();
      setLogger(logger);
      const plugin = new DebugLoggingPlugin({outputPath: outputFile});
      const invocationContext = makeInvocationContext(makeSession());

      await plugin.beforeRunCallback({invocationContext});
      await plugin.afterRunCallback({invocationContext});

      expect(
        messages.some((message) =>
          message.includes('readable beyond its owner'),
        ),
      ).toBe(true);
    },
  );
});

describe('TestDebugLoggingPluginSystemInstructionConfig', () => {
  it('test_system_instruction_included_when_enabled', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath: outputFile,
      includeSystemInstruction: true,
    });
    const invocationContext = makeInvocationContext(makeSession());
    await plugin.beforeRunCallback({invocationContext});

    await plugin.beforeModelCallback({
      callbackContext: makeCallbackContext(invocationContext),
      llmRequest: {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: 'Full system instruction text'},
        liveConnectConfig: {},
        toolsDict: {},
      },
    });
    await plugin.afterRunCallback({invocationContext});

    const data = onlyEntryData(
      await readDocument(),
      DebugEntryType.LLM_REQUEST,
    );
    expect(at(data, 'config')['system_instruction']).toBe(
      'Full system instruction text',
    );
  });

  it('test_system_instruction_length_only_when_disabled', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath: outputFile,
      includeSystemInstruction: false,
    });
    const invocationContext = makeInvocationContext(makeSession());
    await plugin.beforeRunCallback({invocationContext});

    await plugin.beforeModelCallback({
      callbackContext: makeCallbackContext(invocationContext),
      llmRequest: {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: 'Full system instruction text'},
        liveConnectConfig: {},
        toolsDict: {},
      },
    });
    await plugin.afterRunCallback({invocationContext});

    const config = at(
      onlyEntryData(await readDocument(), DebugEntryType.LLM_REQUEST),
      'config',
    );
    expect(config['system_instruction']).toBeUndefined();
    expect(config['system_instruction_length']).toBe(28);
  });
});

describe('DebugLoggingPlugin document format', () => {
  /** Every key a YAML 1.1 reader resolves to a boolean instead of a string. */
  const YAML_11_BOOLEANS = ['yes', 'no', 'on', 'off', 'y', 'n'];

  it('quotes a string a YAML 1.1 reader would read as a boolean', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());
    const toolArgs = Object.fromEntries(
      YAML_11_BOOLEANS.map((word, index) => [`arg${index}`, word]),
    );

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool: makeTool('test_tool'),
      toolArgs,
      toolContext: makeToolContext(invocationContext),
    });
    await plugin.afterRunCallback({invocationContext});

    // js-yaml reads YAML 1.2, where these are plain strings, so the file has
    // to be inspected as text to prove a 1.1 reader sees a string too.
    const text = await fs.readFile(outputFile, 'utf-8');
    for (const word of YAML_11_BOOLEANS) {
      expect(text).toContain(`'${word}'`);
      expect(text).not.toMatch(new RegExp(`: ${word}$`, 'm'));
    }
    const args = at(
      onlyEntryData(await readDocument(), DebugEntryType.TOOL_CALL),
      'args',
    );
    expect(Object.values(args)).toEqual(YAML_11_BOOLEANS);
  });

  it('writes snake_case keys throughout the document', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());
    const callbackContext = makeCallbackContext(invocationContext);

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'hi'}]}],
        config: {systemInstruction: 'be brief', topP: 0.9, topK: 20},
        liveConnectConfig: {},
        toolsDict: {},
      },
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: {
        content: {
          role: 'model',
          parts: [
            {fileData: {fileUri: 'gs://b/o', mimeType: 'text/plain'}},
            {inlineData: {mimeType: 'image/png', data: 'aGk='}},
          ],
        },
        turnComplete: true,
        finishReason: FinishReason.STOP,
        usageMetadata: {promptTokenCount: 1, totalTokenCount: 2},
        partial: false,
      },
    });
    await plugin.afterRunCallback({invocationContext});

    // The plugin authors every key in the file except the pass-through
    // payloads, none of which this invocation carries.
    const camelCased = [
      ...(await fs.readFile(outputFile, 'utf-8')).matchAll(
        /^\s*-?\s*([A-Za-z_][A-Za-z0-9_]*):/gm,
      ),
    ]
      .map((match) => match[1])
      .filter((key) => /[A-Z]/.test(key));
    expect(camelCased).toEqual([]);
  });
});

describe('DebugLoggingPlugin adk-js behaviour', () => {
  it('records the user message that arrives before the run callback', async () => {
    // The runner calls `onUserMessageCallback` first, so a plugin that only
    // opens its record in `beforeRunCallback` drops the message. adk-python
    // has this defect; its unit test hides it by calling the run callback by
    // hand first.
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.onUserMessageCallback({
      invocationContext,
      userMessage: {role: 'user', parts: [{text: 'Hello, world!'}]},
    });
    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    const document = await readDocument();
    const content = at(
      onlyEntryData(document, DebugEntryType.USER_MESSAGE),
      'content',
    );
    expect(listAt(content, 'parts')[0]).toEqual({text: 'Hello, world!'});
    expect(entriesOf(document)[0]['entry_type']).toBe(
      DebugEntryType.USER_MESSAGE,
    );
  });

  it('keeps one record when the run callback fires twice', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.onUserMessageCallback({
      invocationContext,
      userMessage: {role: 'user', parts: [{text: 'Hello, world!'}]},
    });
    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    const document = await readDocument();
    expect(entriesOfType(document, DebugEntryType.USER_MESSAGE)).toHaveLength(
      1,
    );
  });

  it('flushes the oldest invocation once the buffer is full', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath: outputFile,
      maxBufferedInvocations: 2,
    });
    const session = makeSession();

    for (const invocationId of ['inv-1', 'inv-2', 'inv-3']) {
      await plugin.beforeRunCallback({
        invocationContext: makeInvocationContext(session, {invocationId}),
      });
    }

    const documents = await readDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0]['invocation_id']).toBe('inv-1');
    expect(documents[0]['incomplete']).toBe(true);
  });

  it('never evicts an invocation that completed normally', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath: outputFile,
      maxBufferedInvocations: 2,
    });
    const session = makeSession();

    for (const invocationId of ['inv-1', 'inv-2', 'inv-3']) {
      const invocationContext = makeInvocationContext(session, {invocationId});
      await plugin.beforeRunCallback({invocationContext});
      await plugin.afterRunCallback({invocationContext});
    }

    const documents = await readDocuments();
    expect(documents).toHaveLength(3);
    expect(documents.map((document) => document['incomplete'])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('holds every invocation when the bound is not positive', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath: outputFile,
      maxBufferedInvocations: 0,
    });
    const session = makeSession();

    for (const invocationId of ['inv-1', 'inv-2', 'inv-3']) {
      await plugin.beforeRunCallback({
        invocationContext: makeInvocationContext(session, {invocationId}),
      });
    }

    await expect(fs.access(outputFile)).rejects.toThrow();
  });

  it('logs a failed write and still drops the invocation', async () => {
    const {logger, messages} = makeLogger();
    // A directory cannot be opened for appending.
    const plugin = new DebugLoggingPlugin({outputPath: tempDir});
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.beforeRunCallback({invocationContext});
    setLogger(logger);
    await plugin.afterRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    expect(
      messages.some((message) =>
        message.startsWith('Failed to write debug data:'),
      ),
    ).toBe(true);
    expect(messages).toContain(
      'No debug state for invocation test-invocation-id, skipping write',
    );
  });

  it('drops an entry recorded for an unknown invocation', async () => {
    const {logger, messages} = makeLogger();
    setLogger(logger);
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());

    const result = await plugin.afterAgentCallback({
      agent: new LlmAgent({name: 'test_agent'}),
      callbackContext: makeCallbackContext(invocationContext),
    });

    expect(result).toBeUndefined();
    expect(messages).toContain(
      'No debug state for invocation test-invocation-id, skipping entry',
    );
    await expect(fs.access(outputFile)).rejects.toThrow();
  });

  it('records the agent, event and response fields the runner supplies', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const session = makeSession();
    const invocationContext = makeInvocationContext(session, {
      branch: 'root.child',
    });
    const agent = new LlmAgent({name: 'test_agent'});
    const callbackContext = makeCallbackContext(invocationContext);

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeAgentCallback({agent, callbackContext});
    await plugin.afterAgentCallback({agent, callbackContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'hi'}]}],
        config: {
          temperature: 0.5,
          topP: 0.9,
          topK: 20,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          responseSchema: {type: 'STRING'},
        },
        liveConnectConfig: {},
        toolsDict: {my_tool: makeTool('my_tool')},
      },
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: {
        errorCode: 'INTERNAL',
        errorMessage: 'boom',
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 34,
          totalTokenCount: 46,
          cachedContentTokenCount: 2,
        },
        groundingMetadata: {},
        finishReason: FinishReason.STOP,
        modelVersion: 'gemini-2.5-flash-001',
      },
    });
    await plugin.onEventCallback({
      invocationContext,
      event: createEvent({
        author: 'test_agent',
        branch: 'root.child',
        errorCode: 'INTERNAL',
        errorMessage: 'boom',
        groundingMetadata: {},
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 2,
          totalTokenCount: 3,
        },
        longRunningToolIds: ['lrt-1'],
        actions: {
          stateDelta: {counter: 1},
          artifactDelta: {'report.pdf': 2},
          transferToAgent: 'other_agent',
          escalate: true,
          requestedAuthConfigs: {
            'fc-1': {
              authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
              rawAuthCredential: oauthCredential(),
              credentialKey: 'k',
            },
          },
        },
      }),
    });
    await plugin.afterRunCallback({invocationContext});

    const document = await readDocument();
    const raw = await fs.readFile(outputFile, 'utf-8');
    expect(raw).not.toContain(SENTINEL_ACCESS_TOKEN);

    expect(onlyEntryData(document, DebugEntryType.AGENT_START)['branch']).toBe(
      'root.child',
    );
    expect(
      entriesOfType(document, DebugEntryType.AGENT_END)[0]['agent_name'],
    ).toBe('test_agent');

    const request = onlyEntryData(document, DebugEntryType.LLM_REQUEST);
    expect(request['tools']).toEqual(['my_tool']);
    const config = at(request, 'config');
    expect(config['temperature']).toBe(0.5);
    expect(config['top_p']).toBe(0.9);
    expect(config['top_k']).toBe(20);
    expect(config['max_output_tokens']).toBe(1024);
    expect(config['response_mime_type']).toBe('application/json');
    expect(config['has_response_schema']).toBe(true);

    const response = onlyEntryData(document, DebugEntryType.LLM_RESPONSE);
    expect(response['error_code']).toBe('INTERNAL');
    expect(response['error_message']).toBe('boom');
    expect(at(response, 'usage_metadata')['cached_content_token_count']).toBe(
      2,
    );
    expect(response['has_grounding_metadata']).toBe(true);
    expect(response['finish_reason']).toBe('STOP');
    expect(response['model_version']).toBe('gemini-2.5-flash-001');

    const event = onlyEntryData(document, DebugEntryType.EVENT);
    expect(event['branch']).toBe('root.child');
    expect(event['error_code']).toBe('INTERNAL');
    expect(event['has_grounding_metadata']).toBe(true);
    expect(at(event, 'usage_metadata')['total_token_count']).toBe(3);
    expect(event['long_running_tool_ids']).toEqual(['lrt-1']);
    const actions = at(event, 'actions');
    expect(actions['state_delta']).toEqual({counter: 1});
    expect(actions['artifact_delta']).toEqual({'report.pdf': 2});
    expect(actions['transfer_to_agent']).toBe('other_agent');
    expect(actions['escalate']).toBe(true);
    // The count only: an auth config holds a credential.
    expect(actions['requested_auth_configs']).toBe(1);
  });

  it('omits the actions and config blocks when they carry nothing', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext: makeCallbackContext(invocationContext),
      llmRequest: {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {},
        liveConnectConfig: {},
        toolsDict: {},
      },
    });
    await plugin.onEventCallback({
      invocationContext,
      event: createEvent({author: 'test_agent'}),
    });
    await plugin.afterRunCallback({invocationContext});

    const document = await readDocument();
    const request = onlyEntryData(document, DebugEntryType.LLM_REQUEST);
    expect(request['config']).toBeUndefined();
    expect(request['tools']).toBeUndefined();
    expect(
      onlyEntryData(document, DebugEntryType.EVENT)['actions'],
    ).toBeUndefined();
  });

  it('omits a request config the caller never set', async () => {
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext: makeCallbackContext(invocationContext),
      llmRequest: {
        model: 'gemini-2.5-flash',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      },
    });
    await plugin.afterRunCallback({invocationContext});

    expect(
      onlyEntryData(await readDocument(), DebugEntryType.LLM_REQUEST)['config'],
    ).toBeUndefined();
  });

  it('reports only the presence of a non-string system instruction', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath: outputFile,
      includeSystemInstruction: false,
    });
    const invocationContext = makeInvocationContext(makeSession());

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext: makeCallbackContext(invocationContext),
      llmRequest: {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {
          systemInstruction: {role: 'user', parts: [{text: 'be helpful'}]},
        },
        liveConnectConfig: {},
        toolsDict: {},
      },
    });
    await plugin.afterRunCallback({invocationContext});

    const config = at(
      onlyEntryData(await readDocument(), DebugEntryType.LLM_REQUEST),
      'config',
    );
    expect(config['has_system_instruction']).toBe(true);
    expect(config['system_instruction_length']).toBeUndefined();
  });

  it('records every part kind and never the inline bytes', () => {
    const result = serializeContent({
      role: 'user',
      parts: [
        {text: 'hello'},
        {
          functionResponse: {
            id: 'fr-1',
            name: 'do_it',
            response: {'api_key': SENTINEL_CLIENT_SECRET, ok: true},
          },
        },
        {
          inlineData: {
            mimeType: 'image/png',
            displayName: 'shot.png',
            data: 'aGVsbG8=',
          },
        },
        {fileData: {fileUri: 'gs://bucket/o', mimeType: 'text/plain'}},
        {
          codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: '4'},
        },
        {executableCode: {language: Language.PYTHON, code: 'print(2+2)'}},
        {thought: true},
      ],
    });

    expect(result).toEqual({
      role: 'user',
      parts: [
        {text: 'hello'},
        {
          function_response: {
            id: 'fr-1',
            name: 'do_it',
            response: {'api_key': REDACTED, ok: true},
          },
        },
        {
          inline_data: {
            mime_type: 'image/png',
            display_name: 'shot.png',
            _data_omitted: true,
          },
        },
        {file_data: {file_uri: 'gs://bucket/o', mime_type: 'text/plain'}},
        {
          code_execution_result: {outcome: Outcome.OUTCOME_OK, output: '4'},
        },
        {executable_code: {language: Language.PYTHON, code: 'print(2+2)'}},
      ],
    });
    expect(JSON.stringify(result)).not.toContain('aGVsbG8=');
  });

  it('records a content value that carries no parts', () => {
    expect(serializeContent({role: 'model'})).toEqual({
      role: 'model',
      parts: [],
    });
  });

  it.skipIf(!onPosix)('warns once about a permissive output file', async () => {
    await fs.writeFile(outputFile, '');
    await fs.chmod(outputFile, 0o644);
    const {logger, messages} = makeLogger();
    setLogger(logger);
    const plugin = new DebugLoggingPlugin({outputPath: outputFile});
    const session = makeSession();

    for (const invocationId of ['inv-1', 'inv-2']) {
      const invocationContext = makeInvocationContext(session, {invocationId});
      await plugin.beforeRunCallback({invocationContext});
      await plugin.afterRunCallback({invocationContext});
    }

    expect(
      messages.filter((message) =>
        message.includes('readable beyond its owner'),
      ),
    ).toHaveLength(1);
  });
});
