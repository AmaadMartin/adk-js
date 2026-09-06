/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {
  AgentEngineSandboxCodeExecutor,
  CodeExecutionLanguage,
  CodeExecutorContext,
  InvocationContext,
  State,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const SANDBOX_NAME =
  'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456';

describe('AgentEngineSandboxCodeExecutor', () => {
  let executor: AgentEngineSandboxCodeExecutor;
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
  let mockClient: MockClient;

  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    mockClient = {
      agentEnginesInternal: {
        createInternal: vi.fn().mockResolvedValue({
          name: 'operations/create-engine-op',
          done: true,
          response: {
            name: 'projects/test-project/locations/us-central1/reasoningEngines/123',
          },
        }),
        getAgentOperationInternal: vi.fn().mockResolvedValue({
          done: true,
          response: {
            name: 'projects/test-project/locations/us-central1/reasoningEngines/123',
          },
        }),
        sandboxes: {
          getInternal: vi.fn().mockResolvedValue({
            name: 'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456',
            state: 'STATE_RUNNING',
          }),
          createInternal: vi.fn().mockResolvedValue({
            name: 'operations/create-sandbox-op',
            done: true,
            response: {
              name: 'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456',
            },
          }),
          getSandboxOperationInternal: vi.fn().mockResolvedValue({
            done: true,
            response: {
              name: 'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456',
            },
          }),
          executeCodeInternal: vi.fn().mockResolvedValue({
            outputs: [
              {
                mimeType: 'application/json',
                data: Buffer.from(
                  JSON.stringify({msg_out: 'hello world', msg_err: ''}),
                ).toString('base64'),
              },
            ],
          }),
        },
      },
    };
  });

  it('can be initialized with project and location from env', () => {
    executor = new AgentEngineSandboxCodeExecutor({
      client: mockClient as unknown as Client,
    });
    expect(executor).toBeDefined();
  });

  it('throws error if project ID is missing', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    expect(() => new AgentEngineSandboxCodeExecutor({})).toThrow(
      'Project ID is required.',
    );
  });

  it('defaults location to us-central1 if missing in env', () => {
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    executor = new AgentEngineSandboxCodeExecutor({projectId: 'test-project'});
    expect(executor['location']).toBe('us-central1');
  });

  it('uses location from options if provided', () => {
    executor = new AgentEngineSandboxCodeExecutor({
      projectId: 'test-project',
      location: 'custom-location',
    });
    expect(executor['location']).toBe('custom-location');
  });

  it('parses project and location from sandboxResourceName', () => {
    executor = new AgentEngineSandboxCodeExecutor({
      sandboxResourceName:
        'projects/custom-p/locations/custom-l/reasoningEngines/123/sandboxEnvironments/456',
      client: mockClient as unknown as Client,
    });
    expect(executor).toBeDefined();
  });

  it('parses project and location from agentEngineResourceName', () => {
    executor = new AgentEngineSandboxCodeExecutor({
      agentEngineResourceName:
        'projects/custom-p/locations/custom-l/reasoningEngines/123',
      client: mockClient as unknown as Client,
    });
    expect(executor).toBeDefined();
  });

  it('throws error for invalid sandboxResourceName', () => {
    expect(
      () =>
        new AgentEngineSandboxCodeExecutor({sandboxResourceName: 'invalid'}),
    ).toThrow('Invalid sandbox resource name');
  });

  it('throws error for invalid agentEngineResourceName', () => {
    expect(
      () =>
        new AgentEngineSandboxCodeExecutor({
          agentEngineResourceName: 'invalid',
        }),
    ).toThrow('Invalid agent engine resource name');
  });

  describe('executeCode', () => {
    let invocationContext: InvocationContext;

    beforeEach(() => {
      invocationContext = {
        session: {
          id: 'session-1',
          appName: '123',
          userId: 'user-1',
          events: [],
          lastUpdateTime: Date.now(),
          state: {},
        },
      } as unknown as InvocationContext;
      executor = new AgentEngineSandboxCodeExecutor({
        client: mockClient as unknown as Client,
      });
    });

    it('creates agent engine and sandbox if not provided', async () => {
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(mockClient.agentEnginesInternal.createInternal).toHaveBeenCalled();
      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalled();
      expect(result.stdout).toBe('hello world');
    });

    it('publishes the created sandbox name as a state delta', async () => {
      const codeExecutorContext = new CodeExecutorContext(new State({}));

      await executor.executeCode({
        invocationContext,
        codeExecutorContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(codeExecutorContext.getStateDelta()).toEqual({
        _code_execution_context: {
          sandbox_names: {language_python: SANDBOX_NAME},
        },
      });
    });

    it('leaves the caller session state untouched', async () => {
      const codeExecutorContext = new CodeExecutorContext(new State({}));

      await executor.executeCode({
        invocationContext,
        codeExecutorContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(invocationContext.session?.state).toEqual({});
    });

    it('records sandbox names per language', async () => {
      const codeExecutorContext = new CodeExecutorContext(new State({}));

      for (const language of [
        CodeExecutionLanguage.PYTHON,
        CodeExecutionLanguage.JAVASCRIPT,
      ]) {
        await executor.executeCode({
          invocationContext,
          codeExecutorContext,
          codeExecutionInput: {code: 'noop', language, inputFiles: []},
        });
      }

      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalledTimes(2);
      expect(codeExecutorContext.getStateDelta()).toEqual({
        _code_execution_context: {
          sandbox_names: {
            language_python: SANDBOX_NAME,
            language_javascript: SANDBOX_NAME,
          },
        },
      });
    });

    it('creates a sandbox without persisting it when no context is supplied', async () => {
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalled();
      expect(result.stdout).toBe('hello world');
      expect(invocationContext.session?.state).toEqual({});
    });

    it('reuses existing sandbox from the code executor context', async () => {
      const codeExecutorContext = new CodeExecutorContext(new State({}));
      codeExecutorContext.setSandboxName('LANGUAGE_PYTHON', SANDBOX_NAME);

      await executor.executeCode({
        invocationContext,
        codeExecutorContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(mockClient.agentEnginesInternal.createInternal).toHaveBeenCalled();
      expect(
        mockClient.agentEnginesInternal.sandboxes.getInternal,
      ).toHaveBeenCalledWith({name: SANDBOX_NAME});
      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).not.toHaveBeenCalled();
    });

    it('creates new sandbox if existing one is not running', async () => {
      const codeExecutorContext = new CodeExecutorContext(new State({}));
      codeExecutorContext.setSandboxName('LANGUAGE_PYTHON', SANDBOX_NAME);
      mockClient.agentEnginesInternal.sandboxes.getInternal.mockResolvedValue({
        state: 'STATE_EXPIRED',
      });

      await executor.executeCode({
        invocationContext,
        codeExecutorContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalled();
    });

    it('passes input files to sandbox', async () => {
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
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

      expect(
        mockClient.agentEnginesInternal.sandboxes.executeCodeInternal,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: expect.arrayContaining([
            expect.objectContaining({
              mimeType: 'application/json',
            }),
            expect.objectContaining({
              metadata: {
                attributes: {
                  file_name: Buffer.from('data.csv').toString('base64'),
                },
              },
            }),
          ]),
        }),
      );
    });

    it('parses file outputs from sandbox', async () => {
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
        {
          outputs: [
            {
              mimeType: 'image/png',
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('plot.png').toString('base64'),
                },
              },
            },
          ],
        },
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.outputFiles).toHaveLength(1);
      expect(result.outputFiles[0].name).toBe('plot.png');
      expect(result.outputFiles[0].mimeType).toBe('image/png');
    });

    it('guesses mime type if missing in output', async () => {
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
        {
          outputs: [
            {
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('data.csv').toString('base64'),
                },
              },
            },
            {
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('image.png').toString('base64'),
                },
              },
            },
            {
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('image.jpg').toString('base64'),
                },
              },
            },
            {
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('unknown.ext').toString('base64'),
                },
              },
            },
            {
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('doc.pdf').toString('base64'),
                },
              },
            },
            {
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('data.json').toString('base64'),
                },
              },
            },
            {
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('file.').toString('base64'),
                },
              },
            },
          ],
        },
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.outputFiles[0].mimeType).toBe('text/csv');
      expect(result.outputFiles[1].mimeType).toBe('image/png');
      expect(result.outputFiles[2].mimeType).toBe('image/jpeg');
      expect(result.outputFiles[3].mimeType).toBe('application/octet-stream');
      expect(result.outputFiles[4].mimeType).toBe('application/pdf');
      expect(result.outputFiles[5].mimeType).toBe('application/json');
      expect(result.outputFiles[6].mimeType).toBe('application/octet-stream');
    });

    it('uses default file name if missing in output attributes', async () => {
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
        {
          outputs: [
            {
              mimeType: 'text/plain',
              data: 'base64data',
            },
          ],
        },
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.outputFiles).toHaveLength(1);
      expect(result.outputFiles[0].name).toBe('output_file');
    });

    it('uses empty string if data is missing in output', async () => {
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
        {
          outputs: [
            {
              mimeType: 'text/plain',
              metadata: {
                attributes: {
                  file_name: Buffer.from('log.txt').toString('base64'),
                },
              },
            },
          ],
        },
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.outputFiles).toHaveLength(1);
      expect(result.outputFiles[0].content).toBe('');
    });

    it('throws error if agent engine creation operation times out', async () => {
      mockClient.agentEnginesInternal.createInternal.mockResolvedValue({
        name: 'operations/create-engine-op',
        done: false,
      });
      mockClient.agentEnginesInternal.getAgentOperationInternal.mockResolvedValue(
        {
          done: false,
        },
      );

      vi.useFakeTimers();

      const executePromise = executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      await Promise.all([
        expect(executePromise).rejects.toThrow(
          'Agent Engine creation operation operations/create-engine-op did not complete in time.',
        ),
        vi.runAllTimersAsync(),
      ]);

      vi.useRealTimers();
    });

    it('throws error if sandbox creation operation times out', async () => {
      mockClient.agentEnginesInternal.sandboxes.createInternal.mockResolvedValue(
        {
          name: 'operations/create-sandbox-op',
          done: false,
        },
      );
      mockClient.agentEnginesInternal.sandboxes.getSandboxOperationInternal.mockResolvedValue(
        {
          done: false,
        },
      );

      vi.useFakeTimers();

      const executePromise = executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      await Promise.all([
        expect(executePromise).rejects.toThrow(
          'Sandbox creation operation operations/create-sandbox-op did not complete in time.',
        ),
        vi.runAllTimersAsync(),
      ]);

      vi.useRealTimers();
    });

    it('creates a sandbox for a session with no state', async () => {
      const contextWithoutState = {
        session: {
          id: 'session-1',
          appName: '123',
          userId: 'user-1',
          events: [],
          lastUpdateTime: Date.now(),
        },
      } as unknown as InvocationContext;
      const codeExecutorContext = new CodeExecutorContext(new State({}));

      await executor.executeCode({
        invocationContext: contextWithoutState,
        codeExecutorContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(codeExecutorContext.getStateDelta()).toEqual({
        _code_execution_context: {
          sandbox_names: {language_python: SANDBOX_NAME},
        },
      });
      expect(contextWithoutState.session?.state).toBeUndefined();
    });

    it('uses provided sandboxResourceName directly', async () => {
      executor = new AgentEngineSandboxCodeExecutor({
        sandboxResourceName:
          'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456',
        client: mockClient as unknown as Client,
      });

      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(
        mockClient.agentEnginesInternal.sandboxes.getInternal,
      ).not.toHaveBeenCalled();
      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).not.toHaveBeenCalled();
    });

    it('creates new sandbox if getInternal throws error', async () => {
      const codeExecutorContext = new CodeExecutorContext(new State({}));
      codeExecutorContext.setSandboxName('LANGUAGE_PYTHON', SANDBOX_NAME);
      mockClient.agentEnginesInternal.sandboxes.getInternal.mockRejectedValue(
        new Error('API Error'),
      );

      await executor.executeCode({
        invocationContext,
        codeExecutorContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalled();
    });
    it('uses provided agentEngineResourceName directly', async () => {
      executor = new AgentEngineSandboxCodeExecutor({
        agentEngineResourceName:
          'projects/test-project/locations/us-central1/reasoningEngines/123',
        client: mockClient as unknown as Client,
      });

      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(
        mockClient.agentEnginesInternal.createInternal,
      ).not.toHaveBeenCalled();
    });
    it('creates default client if not provided', () => {
      executor = new AgentEngineSandboxCodeExecutor({
        projectId: 'test-project',
      });
      expect(executor['client']).toBeDefined();
    });

    it('handles invalid JSON in output', async () => {
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
        {
          outputs: [
            {
              mimeType: 'application/json',
              data: Buffer.from('invalid json').toString('base64'),
            },
          ],
        },
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.stdout).toBe('invalid json');
    });

    it('handles missing msg_out and msg_err in JSON output', async () => {
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
        {
          outputs: [
            {
              mimeType: 'application/json',
              data: Buffer.from(JSON.stringify({})).toString('base64'),
            },
          ],
        },
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
    it('creates sandbox with LANGUAGE_JAVASCRIPT for JAVASCRIPT language', async () => {
      const codeExecutorContext = new CodeExecutorContext(new State({}));

      await executor.executeCode({
        invocationContext,
        codeExecutorContext,
        codeExecutionInput: {
          code: 'console.log("hello")',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: {
            codeExecutionEnvironment: {
              codeLanguage: 'LANGUAGE_JAVASCRIPT',
            },
          },
        }),
      );

      expect(codeExecutorContext.getStateDelta()).toEqual({
        _code_execution_context: {
          sandbox_names: {language_javascript: SANDBOX_NAME},
        },
      });
    });
  });
});
