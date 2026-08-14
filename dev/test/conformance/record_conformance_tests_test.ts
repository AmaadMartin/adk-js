/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  FunctionTool,
  LLMRegistry,
  LlmAgent,
  LlmResponse,
  StreamingMode,
} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  recordConformanceTests,
  recordTestCase,
} from '../../src/conformance/record_conformance_tests.js';
import {batchLoadYamlTestDefs} from '../../src/conformance/yaml_test_loader.js';
import {AgentRegistry} from '../../src/integration/agent_registry.js';
import {
  AgentClass,
  YamlAgentConfig,
} from '../../src/integration/agent_types.js';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';
import {TestRunner} from '../../src/integration/test_runner.js';
import {TestSpec} from '../../src/integration/test_types.js';

/** Responses the scripted model answers with, one entry per model call. */
let scriptedCalls: LlmResponse[][] = [];

/**
 * A model that answers from {@link scriptedCalls}. Registered with
 * `LLMRegistry` so an agent built from a YAML config that names
 * `scripted-llm` resolves to it and the recorder makes no network call.
 */
class ScriptedLlm extends BaseLlm {
  static readonly supportedModels = ['scripted-llm'];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    for (const response of scriptedCalls.shift() ?? []) {
      yield response;
    }
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm has no live connection.');
  }
}

LLMRegistry.register(ScriptedLlm);

function textCall(text: string): LlmResponse[] {
  return [{content: {role: 'model', parts: [{text}]}}];
}

function scriptedAgent(name: string, tools: FunctionTool[] = []): LlmAgent {
  return new LlmAgent({
    name,
    model: new ScriptedLlm({model: 'scripted-llm'}),
    description: `${name} agent`,
    tools,
  });
}

function greetingSpec(): TestSpec {
  return {
    description: 'Greets the user.',
    agent: 'greeter',
    initialState: {counter: 1},
    userMessages: [{text: 'hello'}],
  };
}

async function loadYaml(file: string): Promise<unknown> {
  return yaml.load(await fs.readFile(file, 'utf-8'));
}

async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

describe('recordTestCase', () => {
  let testCaseDir: string;

  beforeEach(async () => {
    scriptedCalls = [];
    testCaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-record-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.rm(testCaseDir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  it('writes the non-streaming goldens of one test case', async () => {
    scriptedCalls = [textCall('hi there')];

    const files = await recordTestCase({
      agent: scriptedAgent('greeter'),
      spec: greetingSpec(),
      testCaseDir,
      streamingMode: StreamingMode.NONE,
    });

    expect((await fs.readdir(testCaseDir)).sort()).toEqual([
      'generated-recordings.yaml',
      'generated-session.yaml',
    ]);
    expect(await loadYaml(files.sessionFile)).toMatchObject({
      app_name: 'test-runner',
      user_id: 'test-user',
      id: 'test-session',
      state: {counter: 1},
    });
    expect(await loadYaml(files.recordingsFile)).toEqual({
      recordings: [
        {
          user_message_index: 0,
          agent_name: 'greeter',
          llm_recording: {
            llm_request: expect.anything(),
            llm_responses: [
              {content: {role: 'model', parts: [{text: 'hi there'}]}},
            ],
          },
        },
      ],
    });
  });

  it('writes empty goldens for a spec that has no user messages', async () => {
    const files = await recordTestCase({
      agent: scriptedAgent('greeter'),
      spec: {description: 'Does nothing.', agent: 'greeter'},
      testCaseDir,
      streamingMode: StreamingMode.NONE,
    });

    expect(await loadYaml(files.recordingsFile)).toEqual({recordings: []});
    expect(await loadYaml(files.sessionFile)).toMatchObject({
      id: 'test-session',
      events: [],
    });
  });

  it('writes only the sse goldens in sse mode', async () => {
    scriptedCalls = [textCall('hi there')];

    await recordTestCase({
      agent: scriptedAgent('greeter'),
      spec: greetingSpec(),
      testCaseDir,
      streamingMode: StreamingMode.SSE,
    });

    expect((await fs.readdir(testCaseDir)).sort()).toEqual([
      'generated-recordings-sse.yaml',
      'generated-session-sse.yaml',
    ]);
  });

  it('deletes the previous goldens even when the run fails', async () => {
    const sessionFile = path.join(testCaseDir, 'generated-session.yaml');
    const recordingsFile = path.join(testCaseDir, 'generated-recordings.yaml');
    await fs.writeFile(sessionFile, 'stale: true\n', 'utf-8');
    await fs.writeFile(recordingsFile, 'stale: true\n', 'utf-8');

    await expect(
      recordTestCase({
        agent: scriptedAgent('greeter'),
        spec: {...greetingSpec(), userMessages: [{}]},
        testCaseDir,
        streamingMode: StreamingMode.NONE,
      }),
    ).rejects.toThrow();

    expect(await exists(sessionFile)).toBe(false);
    expect(await exists(recordingsFile)).toBe(false);
  });

  it('names the index of a user message with neither text nor content', async () => {
    scriptedCalls = [textCall('hi there')];

    await expect(
      recordTestCase({
        agent: scriptedAgent('greeter'),
        spec: {...greetingSpec(), userMessages: [{text: 'hello'}, {}]},
        testCaseDir,
        streamingMode: StreamingMode.NONE,
      }),
    ).rejects.toThrow('UserMessage at index 1 has neither text nor content');
  });

  it('records a tool call and its result between the two model calls', async () => {
    const rollDie = new FunctionTool({
      name: 'roll_die',
      description: 'Rolls a die.',
      execute: () => ({value: 4}),
    });
    scriptedCalls = [
      [
        {
          content: {
            role: 'model',
            parts: [
              {functionCall: {id: 'fc-1', name: 'roll_die', args: {sides: 6}}},
            ],
          },
        },
      ],
      textCall('You rolled 4.'),
    ];

    const files = await recordTestCase({
      agent: scriptedAgent('roller', [rollDie]),
      spec: {
        description: 'Rolls a die.',
        agent: 'roller',
        userMessages: [{text: 'roll'}],
      },
      testCaseDir,
      streamingMode: StreamingMode.NONE,
    });

    expect(await loadYaml(files.recordingsFile)).toMatchObject({
      recordings: [
        {agent_name: 'roller', llm_recording: expect.anything()},
        {
          agent_name: 'roller',
          tool_recording: {
            tool_call: {id: 'fc-1', name: 'roll_die', args: {sides: 6}},
            tool_response: {
              id: 'fc-1',
              name: 'roll_die',
              response: {value: 4},
            },
          },
        },
        {agent_name: 'roller', llm_recording: expect.anything()},
      ],
    });
  });

  it('answers a spec function response with the id the model assigned', async () => {
    const askUser = new FunctionTool({
      name: 'ask_user',
      description: 'Asks the user.',
      isLongRunning: true,
      execute: () => ({status: 'pending'}),
    });
    scriptedCalls = [
      [
        {
          content: {
            role: 'model',
            parts: [{functionCall: {id: 'fc-9', name: 'ask_user', args: {}}}],
          },
        },
      ],
      textCall('Thanks.'),
    ];

    const files = await recordTestCase({
      agent: scriptedAgent('asker', [askUser]),
      spec: {
        description: 'Asks the user.',
        agent: 'asker',
        userMessages: [
          {text: 'ask me'},
          {
            content: {
              parts: [
                {
                  functionResponse: {
                    id: 'placeholder',
                    name: 'ask_user',
                    response: {answer: 'blue'},
                  },
                },
              ],
            },
          },
        ],
      },
      testCaseDir,
      streamingMode: StreamingMode.NONE,
    });

    expect(await loadYaml(files.sessionFile)).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          content: {
            role: 'user',
            parts: [
              {
                function_response: {
                  id: 'fc-9',
                  name: 'ask_user',
                  response: {answer: 'blue'},
                },
              },
            ],
          },
        }),
      ]),
    });
  });

  it('sends a spec content message that carries no function response', async () => {
    scriptedCalls = [textCall('hi there')];

    const files = await recordTestCase({
      agent: scriptedAgent('greeter'),
      spec: {
        ...greetingSpec(),
        userMessages: [{content: {parts: [{text: 'hello'}]}}],
      },
      testCaseDir,
      streamingMode: StreamingMode.NONE,
    });

    expect(await loadYaml(files.sessionFile)).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          content: {role: 'user', parts: [{text: 'hello'}]},
        }),
      ]),
    });
  });

  it('rejects a spec function response that answers no pending call', async () => {
    await expect(
      recordTestCase({
        agent: scriptedAgent('asker'),
        spec: {
          description: 'Asks the user.',
          agent: 'asker',
          userMessages: [
            {
              content: {
                parts: [
                  {functionResponse: {name: 'ask_user', response: {a: 1}}},
                ],
              },
            },
          ],
        },
        testCaseDir,
        streamingMode: StreamingMode.NONE,
      }),
    ).rejects.toThrow(
      'Function response for ask_user does not match any pending function call.',
    );
  });

  it('replays the goldens it just recorded', async () => {
    scriptedCalls = [textCall('hi there')];
    const agent = scriptedAgent('greeter');
    const caseDir = path.join(testCaseDir, 'greeting_001');
    await fs.mkdir(caseDir);
    await fs.writeFile(
      path.join(caseDir, 'spec.yaml'),
      yaml.dump({
        description: 'Greets the user.',
        agent: 'greeter',
        initial_state: {counter: 1},
        user_messages: [{text: 'hello'}],
      }),
      'utf-8',
    );

    await recordTestCase({
      agent,
      spec: greetingSpec(),
      testCaseDir: caseDir,
      streamingMode: StreamingMode.NONE,
    });

    const agentRegistry = new AgentRegistry(new IntegrationRegistry());
    const agentConfig: YamlAgentConfig = {
      agentClass: AgentClass.LlmAgent,
      name: 'greeter',
      model: 'scripted-llm',
      description: 'greeter agent',
      instruction: '',
      isRootAgent: true,
    };
    agentRegistry.registerAgentConfig('greeter/root_agent', agentConfig);
    agentRegistry.registerAgent('greeter/root_agent', agent);

    const tests = await batchLoadYamlTestDefs(testCaseDir);
    const testInfo = tests.get('greeting_001');
    if (!testInfo) {
      expect.fail('the recorded directory did not load as a test case');
    }

    await expect(
      new TestRunner(agentRegistry).run(testInfo, false),
    ).resolves.toBe(false);
  });
});

describe('recordConformanceTests', () => {
  let root: string;
  let agentsDir: string;
  let testsDir: string;
  let errors: string[];

  beforeEach(async () => {
    scriptedCalls = [];
    errors = [];
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-record-all-'));
    agentsDir = path.join(root, 'agents', 'greeter');
    testsDir = path.join(root, 'tests');
    await fs.mkdir(agentsDir, {recursive: true});
    await fs.writeFile(
      path.join(agentsDir, 'root_agent.yaml'),
      yaml.dump({
        agent_class: 'LlmAgent',
        name: 'greeter',
        model: 'scripted-llm',
        description: 'Greets the user.',
        instruction: 'Say hello.',
      }),
      'utf-8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  async function writeSpec(name: string, content: string): Promise<string> {
    const testCaseDir = path.join(testsDir, name);
    await fs.mkdir(testCaseDir, {recursive: true});
    await fs.writeFile(path.join(testCaseDir, 'spec.yaml'), content, 'utf-8');
    return testCaseDir;
  }

  it('records the good case after reporting a spec that does not load', async () => {
    const badDir = await writeSpec('bad', 'just a string\n');
    const goodDir = await writeSpec(
      'good',
      yaml.dump({
        description: 'Greets the user.',
        agent: 'greeter',
        user_messages: [{text: 'hello'}],
      }),
    );
    scriptedCalls = [textCall('hi there')];

    await recordConformanceTests({
      agentsDir: path.join(root, 'agents'),
      testsDir,
      streamingMode: StreamingMode.NONE,
    });

    expect(errors.join('\n')).toContain('Failed to load');
    expect((await fs.readdir(badDir)).sort()).toEqual(['spec.yaml']);
    expect((await fs.readdir(goodDir)).sort()).toEqual([
      'generated-recordings.yaml',
      'generated-session.yaml',
      'spec.yaml',
    ]);
  });

  it('reports a case whose agent is not in the registry and keeps going', async () => {
    const missingDir = await writeSpec(
      'missing',
      yaml.dump({
        description: 'Uses an unknown agent.',
        agent: 'nobody',
        user_messages: [{text: 'hello'}],
      }),
    );
    const goodDir = await writeSpec(
      'good',
      yaml.dump({
        description: 'Greets the user.',
        agent: 'greeter',
        user_messages: [{text: 'hello'}],
      }),
    );
    scriptedCalls = [textCall('hi there')];

    await recordConformanceTests({
      agentsDir: path.join(root, 'agents'),
      testsDir,
      streamingMode: StreamingMode.NONE,
    });

    expect(errors.join('\n')).toContain('Agent nobody not found in registry');
    expect((await fs.readdir(missingDir)).sort()).toEqual(['spec.yaml']);
    expect(await exists(path.join(goodDir, 'generated-session.yaml'))).toBe(
      true,
    );
  });

  it('rejects a streaming mode that has no goldens before loading anything', async () => {
    await expect(
      recordConformanceTests({
        agentsDir: path.join(root, 'agents'),
        testsDir,
        streamingMode: StreamingMode.BIDI,
      }),
    ).rejects.toThrow('Unsupported streaming mode: bidi');
  });
});
