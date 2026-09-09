/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  isBaseLlm,
  isLlmAgent,
  LlmResponse,
  Runner,
  StreamingMode,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {AgentRegistry} from '../../src/integration/agent_registry.js';
import {
  AgentClass,
  YamlAgentConfig,
} from '../../src/integration/agent_types.js';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';
import {TestRunner} from '../../src/integration/test_runner.js';
import {Recording, TestInfo} from '../../src/integration/test_types.js';

const AGENT_CONFIG_PATH = 'dice_agent/root_agent.yaml';
const SUB_AGENT_CONFIG_PATH = 'dice_agent/tool_agent.yaml';

function agentConfig(overrides: Partial<YamlAgentConfig>): YamlAgentConfig {
  return {
    agentClass: AgentClass.LlmAgent,
    name: 'dice_agent',
    model: 'gemini-2.0-flash',
    description: 'desc',
    instruction: 'inst',
    isRootAgent: true,
    ...overrides,
  };
}

function textResponse(text: string, partial?: boolean): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, partial};
}

/** The events the runner is expected to persist for a one-turn conversation. */
function expectedSession(userText: string, modelText: string) {
  return createSession({
    id: 'test-session',
    appName: 'test-runner',
    userId: 'test-user',
    events: [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: userText}]},
      }),
      createEvent({
        author: 'dice_agent',
        content: {role: 'model', parts: [{text: modelText}]},
      }),
    ],
  });
}

function testInfo(
  recordings: Recording[],
  userText: string,
  modelText: string,
): TestInfo {
  return {
    name: 'core/sse_001',
    spec: {
      description: 'replays an SSE recording',
      agent: 'dice_agent',
      userMessages: [{text: userText}],
    },
    session: expectedSession(userText, modelText),
    recordings: {recordings},
  };
}

describe('TestRunner', () => {
  it('replays the partials and the complete response of one SSE model call', async () => {
    const registry = new AgentRegistry(new IntegrationRegistry());
    registry.registerAgentConfig(AGENT_CONFIG_PATH, agentConfig({}));

    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'dice_agent',
        llmRecording: {
          llmResponses: [
            textResponse('I ', true),
            textResponse('rolled ', true),
            textResponse('I rolled a 4'),
          ],
        },
      },
    ];

    const runner = new TestRunner(registry, StreamingMode.SSE);

    await expect(
      runner.run(testInfo(recordings, 'roll a die', 'I rolled a 4'), false),
    ).resolves.toBe(false);
  });

  it('runs the agent in the streaming mode of the goldens', async () => {
    const registry = new AgentRegistry(new IntegrationRegistry());
    registry.registerAgentConfig(AGENT_CONFIG_PATH, agentConfig({}));
    const runAsync = vi.spyOn(Runner.prototype, 'runAsync');

    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'dice_agent',
        llmRecording: {llmResponses: [textResponse('I rolled a 4')]},
      },
    ];

    const runner = new TestRunner(registry, StreamingMode.SSE);
    await runner.run(testInfo(recordings, 'roll a die', 'I rolled a 4'), false);

    expect(runAsync.mock.calls[0][0].runConfig).toEqual({
      streamingMode: StreamingMode.SSE,
    });
    runAsync.mockRestore();
  });

  it('fails when the recorded response does not match the golden session', async () => {
    const registry = new AgentRegistry(new IntegrationRegistry());
    registry.registerAgentConfig(AGENT_CONFIG_PATH, agentConfig({}));

    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'dice_agent',
        llmRecording: {llmResponses: [textResponse('I rolled a 5')]},
      },
    ];

    const runner = new TestRunner(registry, StreamingMode.SSE);

    await expect(
      runner.run(testInfo(recordings, 'roll a die', 'I rolled a 4'), false),
    ).rejects.toThrow();
  });

  it('leaves a registered workflow agent alone', async () => {
    const registry = new AgentRegistry(new IntegrationRegistry());
    registry.registerAgentConfig(AGENT_CONFIG_PATH, agentConfig({}));
    registry.registerAgentConfig(
      SUB_AGENT_CONFIG_PATH,
      agentConfig({
        agentClass: AgentClass.SequentialAgent,
        name: 'workflow_agent',
        isRootAgent: false,
      }),
    );
    const workflowAgent = registry.getAgent(SUB_AGENT_CONFIG_PATH);

    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'dice_agent',
        llmRecording: {llmResponses: [textResponse('I rolled a 4')]},
      },
    ];

    const runner = new TestRunner(registry, StreamingMode.NONE);

    await expect(
      runner.run(testInfo(recordings, 'roll a die', 'I rolled a 4'), false),
    ).resolves.toBe(false);
    expect(isLlmAgent(workflowAgent)).toBe(false);
  });

  it('gives a replay model to an agent reachable only through an AgentTool', async () => {
    const registry = new AgentRegistry(new IntegrationRegistry());
    registry.registerAgentConfig(
      SUB_AGENT_CONFIG_PATH,
      agentConfig({name: 'tool_agent', isRootAgent: false}),
    );
    registry.registerAgentConfig(
      AGENT_CONFIG_PATH,
      agentConfig({
        tools: [
          {
            name: 'AgentTool',
            args: {agent: {configPath: SUB_AGENT_CONFIG_PATH}},
          },
        ],
      }),
    );

    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'dice_agent',
        llmRecording: {llmResponses: [textResponse('I rolled a 4')]},
      },
    ];

    const runner = new TestRunner(registry, StreamingMode.NONE);
    await runner.run(testInfo(recordings, 'roll a die', 'I rolled a 4'), false);

    const toolAgent = registry.getAgent(SUB_AGENT_CONFIG_PATH);
    if (!isLlmAgent(toolAgent)) {
      expect.fail('the AgentTool target should be an LlmAgent');
    }
    if (!isBaseLlm(toolAgent.model)) {
      expect.fail('the AgentTool target should hold a replay model');
    }
    expect(toolAgent.model.model).toBe('replay-llm');
  });

  it('skips a test named in SKIPPED_TESTS unless forced', async () => {
    const registry = new AgentRegistry(new IntegrationRegistry());
    const info = testInfo([], 'roll a die', 'I rolled a 4');
    info.name = 'workflow/loop_001';

    const runner = new TestRunner(registry, StreamingMode.NONE);

    await expect(runner.run(info, false)).resolves.toBe(true);
  });

  it('throws when the spec names an agent that is not registered', async () => {
    const registry = new AgentRegistry(new IntegrationRegistry());
    const runner = new TestRunner(registry, StreamingMode.NONE);

    await expect(
      runner.run(testInfo([], 'roll a die', 'I rolled a 4'), false),
    ).rejects.toThrow('Agent dice_agent not found in registry');
  });
});
