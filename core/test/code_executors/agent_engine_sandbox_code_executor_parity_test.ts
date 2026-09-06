/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python reference tests for `AgentEngineSandboxCodeExecutor`, ported
 * to TypeScript. Each `it(...)` keeps its Python name verbatim, so a reviewer
 * can match the two suites by grep.
 *
 * Source: adk-python `main`,
 * `tests/unittests/code_executors/test_agent_engine_sandbox_code_executor.py`.
 */

import {Client} from '@google-cloud/vertexai';
import {
  AgentEngineSandboxCodeExecutor,
  CodeExecutionLanguage,
  InvocationContext,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const AGENT_ENGINE_NAME =
  'projects/123/locations/us-central1/reasoningEngines/456';
const SANDBOX_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironments/789`;
const EXISTING_SANDBOX_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironments/111`;

interface MockClient {
  agentEnginesInternal: {
    createInternal: ReturnType<typeof vi.fn>;
    getAgentOperationInternal: ReturnType<typeof vi.fn>;
    sandboxes: {
      getInternal: ReturnType<typeof vi.fn>;
      createInternal: ReturnType<typeof vi.fn>;
      getSandboxOperationInternal: ReturnType<typeof vi.fn>;
      executeCodeInternal: ReturnType<typeof vi.fn>;
    };
  };
}

/** Encodes a JSON sandbox output the way the API returns it. */
function jsonOutput(payload: Record<string, string>) {
  return {
    mimeType: 'application/json',
    data: Buffer.from(JSON.stringify(payload)).toString('base64'),
  };
}

/** The single chunk `executeCodeInternal` receives for a code-only request. */
function codeChunk(code: string) {
  return {
    mimeType: 'application/json',
    data: Buffer.from(JSON.stringify({code})).toString('base64'),
  };
}

function createMockClient(): MockClient {
  const engineOperation = {
    name: 'operations/create-engine-op',
    done: true,
    response: {name: AGENT_ENGINE_NAME},
  };
  const sandboxOperation = {
    name: 'operations/create-sandbox-op',
    done: true,
    response: {name: SANDBOX_NAME},
  };

  return {
    agentEnginesInternal: {
      createInternal: vi.fn().mockResolvedValue(engineOperation),
      getAgentOperationInternal: vi.fn().mockResolvedValue(engineOperation),
      sandboxes: {
        getInternal: vi
          .fn()
          .mockResolvedValue({name: SANDBOX_NAME, state: 'STATE_RUNNING'}),
        createInternal: vi.fn().mockResolvedValue(sandboxOperation),
        getSandboxOperationInternal: vi
          .fn()
          .mockResolvedValue(sandboxOperation),
        executeCodeInternal: vi.fn().mockResolvedValue({
          outputs: [jsonOutput({msg_out: '', msg_err: ''})],
        }),
      },
    },
  };
}

describe('AgentEngineSandboxCodeExecutor parity with adk-python', () => {
  let mockClient: MockClient;
  // `Client` is a third-party class a partial mock cannot implement, so the
  // injection cast lives here once instead of at every construction site.
  let client: Client;
  let invocationContext: InvocationContext;

  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    mockClient = createMockClient();
    client = mockClient as unknown as Client;
    invocationContext = {
      invocationId: 'test-invocation-123',
      session: {
        id: 'session-1',
        appName: 'app',
        userId: 'user-1',
        events: [],
        lastUpdateTime: Date.now(),
        state: {},
      },
    } as unknown as InvocationContext;
  });

  it('test_init_with_sandbox_overrides', () => {
    const executor = new AgentEngineSandboxCodeExecutor({
      sandboxResourceName: SANDBOX_NAME,
      client,
    });

    expect(executor.sandboxResourceName).toBe(SANDBOX_NAME);
  });

  it('test_init_with_sandbox_overrides_throws_error', () => {
    expect(
      () =>
        new AgentEngineSandboxCodeExecutor({
          sandboxResourceName:
            'projects/123/locations/us-central1/reasoningEngines/456/sandboxes/789',
          client,
        }),
    ).toThrow('Invalid sandbox resource name');
  });

  it('test_init_with_agent_engine_overrides_throws_error', () => {
    expect(
      () =>
        new AgentEngineSandboxCodeExecutor({
          agentEngineResourceName:
            'projects/123/locations/us-central1/reason/456',
          client,
        }),
    ).toThrow('Invalid agent engine resource name');
  });

  it('test_execute_code_success', async () => {
    mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
      {
        outputs: [
          jsonOutput({msg_out: 'hello world', msg_err: ''}),
          {
            mimeType: 'text/plain',
            data: Buffer.from('file content').toString('base64'),
            metadata: {
              attributes: {
                file_name: Buffer.from('file.txt').toString('base64'),
              },
            },
          },
          {
            mimeType: 'image/png',
            data: Buffer.from('\x89PNG\r\n\x1a\n').toString('base64'),
            metadata: {
              attributes: {
                file_name: Buffer.from('file.png').toString('base64'),
              },
            },
          },
        ],
      },
    );
    const executor = new AgentEngineSandboxCodeExecutor({
      sandboxResourceName: SANDBOX_NAME,
      client,
    });

    const result = await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: 'print("hello world")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('');
    expect(result.outputFiles[0].name).toBe('file.txt');
    expect(result.outputFiles[0].mimeType).toBe('text/plain');
    expect(result.outputFiles[0].content).toBe(
      Buffer.from('file content').toString('base64'),
    );
    expect(result.outputFiles[1].name).toBe('file.png');
    expect(result.outputFiles[1].mimeType).toBe('image/png');
    expect(result.outputFiles[1].content).toBe(
      Buffer.from('\x89PNG\r\n\x1a\n').toString('base64'),
    );
    expect(
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal,
    ).toHaveBeenCalledExactlyOnceWith({
      name: SANDBOX_NAME,
      inputs: [codeChunk('print("hello world")')],
    });
  });

  it('test_execute_code_sends_input_files_with_content_key', async () => {
    const executor = new AgentEngineSandboxCodeExecutor({
      sandboxResourceName: SANDBOX_NAME,
      client,
    });

    await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: 'print("hi")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [
          {
            name: 'data.csv',
            content: Buffer.from('a,b,c').toString('base64'),
            mimeType: 'text/csv',
          },
        ],
      },
    });

    const [request] =
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mock
        .calls[0];
    expect(request.inputs[1]).toEqual({
      mimeType: 'text/csv',
      data: Buffer.from('a,b,c').toString('base64'),
      metadata: {
        attributes: {file_name: Buffer.from('data.csv').toString('base64')},
      },
    });
  });

  it('test_execute_code_recreates_sandbox_when_get_returns_none', async () => {
    invocationContext.session!.state!['sandbox_name'] = EXISTING_SANDBOX_NAME;
    mockClient.agentEnginesInternal.sandboxes.getInternal.mockResolvedValue(
      null,
    );
    mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
      {outputs: [jsonOutput({msg_out: 'recreated sandbox run', msg_err: ''})]},
    );
    const executor = new AgentEngineSandboxCodeExecutor({
      agentEngineResourceName: AGENT_ENGINE_NAME,
      client,
    });

    const result = await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: 'print("hello world")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    expect(result.stdout).toBe('recreated sandbox run');
    expect(
      mockClient.agentEnginesInternal.sandboxes.getInternal,
    ).toHaveBeenCalledExactlyOnceWith({name: EXISTING_SANDBOX_NAME});
    expect(
      mockClient.agentEnginesInternal.sandboxes.createInternal,
    ).toHaveBeenCalledOnce();
    expect(invocationContext.session!.state!['sandbox_name']).toBe(
      SANDBOX_NAME,
    );
    expect(
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal,
    ).toHaveBeenCalledExactlyOnceWith({
      name: SANDBOX_NAME,
      inputs: [codeChunk('print("hello world")')],
    });
  });

  it('test_execute_code_recreates_sandbox_when_get_raises_client_error', async () => {
    invocationContext.session!.state!['sandbox_name'] = EXISTING_SANDBOX_NAME;
    mockClient.agentEnginesInternal.sandboxes.getInternal.mockRejectedValue(
      Object.assign(new Error('Not Found'), {status: 404}),
    );
    mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
      {outputs: [jsonOutput({msg_out: 'recreated sandbox run', msg_err: ''})]},
    );
    const executor = new AgentEngineSandboxCodeExecutor({
      agentEngineResourceName: AGENT_ENGINE_NAME,
      client,
    });

    const result = await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: 'print("hello world")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    expect(result.stdout).toBe('recreated sandbox run');
    expect(
      mockClient.agentEnginesInternal.sandboxes.getInternal,
    ).toHaveBeenCalledExactlyOnceWith({name: EXISTING_SANDBOX_NAME});
    expect(
      mockClient.agentEnginesInternal.sandboxes.createInternal,
    ).toHaveBeenCalledOnce();
    expect(invocationContext.session!.state!['sandbox_name']).toBe(
      SANDBOX_NAME,
    );
    expect(
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal,
    ).toHaveBeenCalledExactlyOnceWith({
      name: SANDBOX_NAME,
      inputs: [codeChunk('print("hello world")')],
    });
  });

  it('test_execute_code_creates_sandbox_if_missing', async () => {
    const executor = new AgentEngineSandboxCodeExecutor({
      agentEngineResourceName: AGENT_ENGINE_NAME,
      client,
    });

    await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: 'print("hello world")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    expect(
      mockClient.agentEnginesInternal.sandboxes.createInternal,
    ).toHaveBeenCalledOnce();
    const [createRequest] =
      mockClient.agentEnginesInternal.sandboxes.createInternal.mock.calls[0];
    expect(createRequest.name).toBe(AGENT_ENGINE_NAME);
    expect(invocationContext.session!.state!['sandbox_name']).toBe(
      SANDBOX_NAME,
    );
    expect(
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal,
    ).toHaveBeenCalledExactlyOnceWith({
      name: SANDBOX_NAME,
      inputs: [codeChunk('print("hello world")')],
    });
  });

  it('test_execute_code_sends_correct_field_names_for_input_files', async () => {
    const code = "import pandas as pd; df = pd.read_csv('data.csv')";
    const executor = new AgentEngineSandboxCodeExecutor({
      sandboxResourceName: SANDBOX_NAME,
      client,
    });

    await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code,
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [
          {
            name: 'data.csv',
            content: Buffer.from('col1,col2\n1,2').toString('base64'),
            mimeType: 'text/csv',
          },
        ],
      },
    });

    expect(
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal,
    ).toHaveBeenCalledExactlyOnceWith({
      name: SANDBOX_NAME,
      inputs: [
        codeChunk(code),
        {
          mimeType: 'text/csv',
          data: Buffer.from('col1,col2\n1,2').toString('base64'),
          metadata: {
            attributes: {file_name: Buffer.from('data.csv').toString('base64')},
          },
        },
      ],
    });
  });

  // adk-js keeps the project and the location private, so the reference's
  // assertions on `_project_id` and `_location` become an assertion on the
  // resource name the sandbox is created under.
  it('test_init_with_agent_engine_resource_name', async () => {
    const executor = new AgentEngineSandboxCodeExecutor({
      agentEngineResourceName: AGENT_ENGINE_NAME,
      client,
    });

    expect(executor.agentEngineResourceName).toBe(AGENT_ENGINE_NAME);
    expect(executor.sandboxResourceName).toBeUndefined();

    await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: 'print("hello world")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    const [createRequest] =
      mockClient.agentEnginesInternal.sandboxes.createInternal.mock.calls[0];
    expect(createRequest.name).toBe(
      'projects/123/locations/us-central1/reasoningEngines/456',
    );
  });

  it('test_execute_code_with_auto_create_agent_engine', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project-456');
    const executor = new AgentEngineSandboxCodeExecutor({
      client,
    });

    await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: 'print("hello world")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    expect(
      mockClient.agentEnginesInternal.createInternal,
    ).toHaveBeenCalledOnce();
    expect(executor.agentEngineResourceName).toBe(AGENT_ENGINE_NAME);
    expect(executor.sandboxResourceName).toBeUndefined();
    expect(
      mockClient.agentEnginesInternal.sandboxes.createInternal,
    ).toHaveBeenCalledOnce();
    expect(invocationContext.session!.state!['sandbox_name']).toBe(
      SANDBOX_NAME,
    );
  });

  it('test_execute_code_auto_create_agent_engine_fails', async () => {
    mockClient.agentEnginesInternal.createInternal.mockRejectedValue(
      new Error('Failed to auto-create Agent Engine'),
    );
    const executor = new AgentEngineSandboxCodeExecutor({
      client,
    });

    await expect(
      executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello world")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      }),
    ).rejects.toThrow('Failed to auto-create Agent Engine');
    expect(
      mockClient.agentEnginesInternal.sandboxes.createInternal,
    ).not.toHaveBeenCalled();
  });
});
