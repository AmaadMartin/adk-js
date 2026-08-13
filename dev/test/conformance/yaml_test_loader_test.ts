/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fg from 'fast-glob';
import * as fs from 'node:fs/promises';
import {Readable} from 'node:stream';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {batchLoadYamlTestDefs} from '../../src/conformance/yaml_test_loader.js';
import {TestInfo} from '../../src/integration/test_types.js';

vi.mock('fast-glob', () => ({
  default: {
    stream: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const SPEC_YAML = `
description: Test description
agent: test-agent
initial_state:
  key: value
user_messages:
  - text: hello
`;

const SESSION_YAML = `
app_name: test-app
user_id: user-1
id: session-1
events:
  - author: user
    content:
      parts:
        - text: hello
`;

const RECORDINGS_YAML = `
recordings:
  - user_message_index: 0
    agent_name: test-agent
    llm_recording:
      llm_response:
        content:
          parts:
            - text: hi
`;

describe('batchLoadYamlTestDefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Silence console.log during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should load and parse test definitions recursively', async () => {
    const rootDir = '/root/tests';
    const mockFiles = ['/root/tests/category/test1/spec.yaml'];

    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    (fs.readFile as Mock).mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('spec.yaml')) return SPEC_YAML;
      if (filePath.endsWith('generated-session.yaml')) return SESSION_YAML;
      if (filePath.endsWith('generated-recordings.yaml'))
        return RECORDINGS_YAML;
      throw new Error(`File not found: ${filePath}`);
    });

    const tests = await batchLoadYamlTestDefs(rootDir);

    expect(fg.stream).toHaveBeenCalledWith('**/spec.{yaml,yml}', {
      cwd: rootDir,
      absolute: true,
    });

    expect(tests.size).toBe(1);
    const test = tests.get('category/test1');
    expect(test).toBeDefined();
    expect(test?.name).toBe('category/test1');

    // Check spec parsing and camelCase conversion
    expect(test?.spec).toMatchObject({
      description: 'Test description',
      agent: 'test-agent',
      initialState: {key: 'value'},
      userMessages: [{text: 'hello'}],
    });

    // Check session parsing and camelCase conversion
    expect(test?.session).toMatchObject({
      appName: 'test-app',
      userId: 'user-1',
      id: 'session-1',
    });

    // Check recordings parsing and camelCase conversion
    expect(test?.recordings.recordings[0]).toMatchObject({
      userMessageIndex: 0,
      agentName: 'test-agent',
    });
  });

  it('should handle multiple tests in different directories', async () => {
    const rootDir = '/root/tests';
    const mockFiles = ['/root/tests/t1/spec.yaml', '/root/tests/t2/spec.yaml'];

    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);
    (fs.readFile as Mock).mockResolvedValue('{}');

    const tests = await batchLoadYamlTestDefs(rootDir);
    expect(tests.size).toBe(2);
    expect(tests.has('t1')).toBe(true);
    expect(tests.has('t2')).toBe(true);
  });

  it('should load and parse test definitions with Windows-style paths', async () => {
    const rootDir = 'C:\\root\\tests';
    const mockFiles = ['C:\\root\\tests\\category\\test1\\spec.yaml'];

    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    (fs.readFile as Mock).mockImplementation(async (filePath: string) => {
      if (filePath.includes('spec.yaml')) return SPEC_YAML;
      if (filePath.includes('generated-session.yaml')) return SESSION_YAML;
      if (filePath.includes('generated-recordings.yaml'))
        return RECORDINGS_YAML;
      throw new Error(`File not found: ${filePath}`);
    });

    const tests = await batchLoadYamlTestDefs(rootDir);

    expect(fg.stream).toHaveBeenCalledWith('**/spec.{yaml,yml}', {
      cwd: rootDir,
      absolute: true,
    });

    expect(tests.size).toBe(1);
    const expectedKey = 'category/test1';
    const test = tests.get(expectedKey);
    expect(test).toBeDefined();
    expect(test?.name).toBe(expectedKey);
    expect(test?.spec.agent).toBe('test-agent');
  });

  it('should throw an error if a required file is missing', async () => {
    const rootDir = '/root/tests';
    (fg.stream as unknown as Mock).mockReturnValue([
      '/root/tests/t1/spec.yaml',
    ]);
    (fs.readFile as Mock).mockRejectedValue(new Error('File not found'));

    await expect(batchLoadYamlTestDefs(rootDir)).rejects.toThrow(
      'File not found',
    );
  });
});

const OPAQUE_ROOT_DIR = '/root/tests';

const OPAQUE_STATE_SESSION_YAML = `
app_name: test-app
user_id: user-1
id: session-1
state:
  _adk_replay_config:
    streaming_mode: none
  user_name: alice
  'app:seen_count': 3
  'user:pref_lang': en
  nested_config:
    inner_key: 1
events: []
`;

const STATE_DELTA_SESSION_YAML = `
app_name: test-app
user_id: user-1
id: session-1
events:
  - author: agent
    actions:
      state_delta:
        conversation_limit_reached: 'True'
        _adk_recordings_config: true
      transfer_to_agent: sub_agent
`;

const FUNCTION_PAYLOAD_SESSION_YAML = `
app_name: test-app
user_id: user-1
id: session-1
events:
  - author: agent
    content:
      parts:
        - function_call:
            name: transfer_to_agent
            args:
              agent_name: sub_agent
              max_stops: 0
        - function_response:
            name: t
            response:
              trip_type: one-way
              nested:
                inner_key: 1
`;

const ARTIFACT_DELTA_SESSION_YAML = `
app_name: test-app
user_id: user-1
id: session-1
events:
  - author: agent
    actions:
      artifact_delta:
        'my_file.txt': 1
        'report-v2.json': 2
`;

const METADATA_SESSION_YAML = `
app_name: test-app
user_id: user-1
id: session-1
events:
  - author: agent
    custom_metadata:
      trace_id: abc
    actions:
      custom_metadata:
        run_tag: nightly
      agent_state:
        cursor_pos: 2
`;

const OUTPUT_AND_AUTH_SESSION_YAML = `
app_name: test-app
user_id: user-1
id: session-1
events:
  - author: agent
    output:
      node_result: ok
      nested_out:
        inner_key: 1
    actions:
      requested_tool_confirmations:
        adk-call-1:
          hint: confirm this
          confirmed: false
          payload:
            order_id: 7
      requested_auth_configs:
        adk-call-2:
          auth_scheme:
            type: apiKey
          credential_key: my_key
`;

const OPAQUE_SPEC_YAML = `
description: Test description
agent: test-agent
initial_state:
  'user:pref_lang': en
  seen_count: 0
user_messages:
  - text: hi
    state_delta:
      my_key: 1
`;

const OPAQUE_RECORDINGS_YAML = `
recordings:
  - user_message_index: 0
    agent_name: test-agent
    llm_recording:
      llm_response:
        content:
          parts:
            - function_call:
                name: compute_fare
                args:
                  base_fare: 1
  - user_message_index: 0
    agent_name: test-agent
    tool_recording:
      tool_call:
        name: compute_fare
        args:
          base_fare: 1
      tool_response:
        name: compute_fare
        response:
          total_cost: 2
          is_confirmed: true
`;

const REQUEST_METADATA_RECORDINGS_YAML = `
recordings:
  - user_message_index: 0
    agent_name: test-agent
    llm_recording:
      llm_request:
        contents:
          - role: model
            parts:
              - function_call:
                  name: compute_fare
                  args:
                    base_fare: 1
      llm_response:
        custom_metadata:
          trace_id: abc
`;

describe('batchLoadYamlTestDefs opaque payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  /**
   * Loads one test from the three YAML documents, falling back to the plain
   * fixtures above for any document the case does not care about.
   */
  async function loadTest(files: {
    spec?: string;
    session?: string;
    recordings?: string;
  }): Promise<TestInfo> {
    vi.mocked(fg.stream).mockReturnValue(
      Readable.from([`${OPAQUE_ROOT_DIR}/t1/spec.yaml`]),
    );
    vi.mocked(fs.readFile).mockImplementation(async (file) => {
      const filePath = String(file);
      if (filePath.endsWith('spec.yaml')) return files.spec ?? SPEC_YAML;
      if (filePath.endsWith('generated-session.yaml'))
        return files.session ?? SESSION_YAML;
      if (filePath.endsWith('generated-recordings.yaml'))
        return files.recordings ?? RECORDINGS_YAML;
      throw new Error(`File not found: ${filePath}`);
    });

    const test = (await batchLoadYamlTestDefs(OPAQUE_ROOT_DIR)).get('t1');
    if (!test) {
      expect.fail('expected a loaded test named t1');
    }
    return test;
  }

  it('preserves session state keys and converts the session envelope', async () => {
    const test = await loadTest({session: OPAQUE_STATE_SESSION_YAML});

    expect(test.session.state).toEqual({
      _adk_replay_config: {streaming_mode: 'none'},
      user_name: 'alice',
      'app:seen_count': 3,
      'user:pref_lang': 'en',
      nested_config: {inner_key: 1},
    });
    expect(test.session.appName).toBe('test-app');
    expect(test.session.userId).toBe('user-1');
  });

  it('preserves state delta contents but converts the state delta key', async () => {
    const test = await loadTest({session: STATE_DELTA_SESSION_YAML});

    const actions = test.session.events[0].actions;
    expect(actions.stateDelta).toEqual({
      conversation_limit_reached: 'True',
      _adk_recordings_config: true,
    });
    expect('state_delta' in actions).toBe(false);
    expect(actions.transferToAgent).toBe('sub_agent');
  });

  it('preserves function call args and function response payloads', async () => {
    const test = await loadTest({session: FUNCTION_PAYLOAD_SESSION_YAML});

    const parts = test.session.events[0].content?.parts;
    if (!parts) {
      expect.fail('expected the event content to have parts');
    }
    expect(Object.keys(parts[0])).toEqual(['functionCall']);
    expect(parts[0].functionCall?.args).toEqual({
      agent_name: 'sub_agent',
      max_stops: 0,
    });
    expect(Object.keys(parts[1])).toEqual(['functionResponse']);
    expect(parts[1].functionResponse?.response).toEqual({
      trip_type: 'one-way',
      nested: {inner_key: 1},
    });
  });

  it('preserves artifact delta filenames', async () => {
    const test = await loadTest({session: ARTIFACT_DELTA_SESSION_YAML});

    expect(test.session.events[0].actions.artifactDelta).toEqual({
      'my_file.txt': 1,
      'report-v2.json': 2,
    });
  });

  it('preserves event custom metadata and agent state', async () => {
    const test = await loadTest({session: METADATA_SESSION_YAML});

    const event = test.session.events[0];
    expect(event.customMetadata).toEqual({trace_id: 'abc'});
    expect(event.actions).toEqual({
      customMetadata: {run_tag: 'nightly'},
      agentState: {cursor_pos: 2},
    });
  });

  it('preserves event output and requested tool confirmations', async () => {
    const test = await loadTest({session: OUTPUT_AND_AUTH_SESSION_YAML});

    const event = test.session.events[0];
    expect(event.output).toEqual({
      node_result: 'ok',
      nested_out: {inner_key: 1},
    });
    expect(event.actions.requestedToolConfirmations).toEqual({
      'adk-call-1': {
        hint: 'confirm this',
        confirmed: false,
        payload: {order_id: 7},
      },
    });
  });

  it('converts requested auth config values, which are ADK schema', async () => {
    const test = await loadTest({session: OUTPUT_AND_AUTH_SESSION_YAML});

    const authConfigs = test.session.events[0].actions.requestedAuthConfigs;
    expect(Object.values(authConfigs)[0]).toEqual({
      authScheme: {type: 'apiKey'},
      credentialKey: 'my_key',
    });
  });

  it('preserves spec initial state and user message state deltas', async () => {
    const test = await loadTest({spec: OPAQUE_SPEC_YAML});

    expect(test.spec.initialState).toEqual({
      'user:pref_lang': 'en',
      seen_count: 0,
    });
    expect(test.spec.userMessages).toEqual([
      {text: 'hi', stateDelta: {my_key: 1}},
    ]);
  });

  it('preserves recorded tool and response payloads', async () => {
    const test = await loadTest({recordings: OPAQUE_RECORDINGS_YAML});

    const [llm, tool] = test.recordings.recordings;
    expect(llm.userMessageIndex).toBe(0);
    expect(llm.agentName).toBe('test-agent');
    expect(
      llm.llmRecording?.llmResponse?.content?.parts?.[0].functionCall?.args,
    ).toEqual({base_fare: 1});
    expect(tool.toolRecording?.toolCall?.args).toEqual({base_fare: 1});
    expect(tool.toolRecording?.toolResponse?.response).toEqual({
      total_cost: 2,
      is_confirmed: true,
    });
  });

  it('preserves recorded request args and response custom metadata', async () => {
    const test = await loadTest({recordings: REQUEST_METADATA_RECORDINGS_YAML});

    const recording = test.recordings.recordings[0].llmRecording;
    expect(
      recording?.llmRequest?.contents[0].parts?.[0].functionCall?.args,
    ).toEqual({base_fare: 1});
    expect(recording?.llmResponse?.customMetadata).toEqual({trace_id: 'abc'});
  });
});
