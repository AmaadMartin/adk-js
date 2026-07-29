/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  BaseAgent,
  InMemorySessionService,
  isLlmAgent,
  Runner,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {cloneDeep} from 'lodash-es';
import * as assert from 'node:assert';
import {AgentRegistry} from './agent_registry.js';
import {DummyLlm} from './dummy_llm.js';
import {normalizeEvent} from './event_filter.js';
import {ReplayPlugin} from './replay_plugin.js';
import {TestInfo, UserMessage} from './test_types.js';

const SKIPPED_TESTS = [
  {
    name: 'tool/example_tool_001',
    reason: 'ExampleTool is not implemented yet.',
  },
  {name: 'workflow/loop_001', reason: 'ExitLoopTool is not implemented yet.'},
  {
    name: 'core/multi_005',
    reason: 'Suspected broken test. Need to re-evaluate.',
  },
  {
    name: 'tool/long_running_tool_001',
    reason: 'Suspected broken test. Need to re-evaluate.',
  },
];

export class TestRunner {
  constructor(private agentRegistry: AgentRegistry) {}

  async run(testInfo: TestInfo, force: boolean): Promise<boolean> {
    // skip tests for unimplemented features
    if (!force) {
      for (const skip of SKIPPED_TESTS) {
        if (skip.name == testInfo.name) {
          console.log('Skipping test', testInfo.name, 'because:', skip.reason);
          return true;
        }
      }
    }

    const agentName = testInfo.spec.agent;
    // Use the "short name" in the specs. This could possibly break
    // if there is more than one agent with the same name. Full names
    // are qualified by the file path.
    const agent = this.agentRegistry.getRootAgentByShortName(agentName);
    if (!agent) {
      throw new Error(`Agent ${agentName} not found in registry`);
    }

    // Clone recordings to track consumption without mutating the original test info
    const recordings = cloneDeep(testInfo.recordings.recordings);
    const context = {userMessageIndex: 0};
    injectDummyLlm(agent);

    const replayPlugin = new ReplayPlugin(recordings, context);
    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      agent,
      sessionService,
      plugins: [replayPlugin],
      appName: 'test-runner',
    });

    const userId = 'test-user';
    const sessionId = 'test-session';

    // Create the session explicitly
    await sessionService.createSession({
      appName: 'test-runner',
      userId,
      sessionId,
    });

    const userMessages = testInfo.spec.userMessages!;

    for (let i = 0; i < userMessages.length; i++) {
      context.userMessageIndex = i;
      const userMsg = userMessages[i];
      const content = userMessageToContent(userMsg);

      const iterator = runner.runAsync({
        userId,
        sessionId,
        newMessage: content,
        stateDelta: i === 0 ? testInfo.spec.initialState : undefined,
      });

      for await (const _ of iterator) {
        // Consume events
      }
    }

    const session = await sessionService.getSession({
      appName: 'test-runner',
      userId,
      sessionId,
    });

    if (!session) {
      throw new Error('Session not found after execution');
    }

    validateSession(session, testInfo.session);

    return false;
  }
}

function injectDummyLlm(agent: BaseAgent) {
  if (isLlmAgent(agent)) {
    agent.model = new DummyLlm();
  }

  // Traverse subagents
  const subAgents = agent.subAgents;
  if (subAgents && Array.isArray(subAgents)) {
    for (const sub of subAgents) {
      injectDummyLlm(sub);
    }
  }
}

function userMessageToContent(msg: UserMessage): Content {
  if (msg.content) {
    const content = msg.content;
    content.role = 'user';
    return content;
  }
  if (msg.text) {
    return {role: 'user', parts: [{text: msg.text}]};
  }

  throw new Error('Either Content text or content field is required');
}

function validateSession(actual: Session, expected: Session) {
  const actualEvents = actual.events.map(normalizeEvent);
  const expectedEvents = expected.events.map(normalizeEvent);

  assert.deepStrictEqual(actualEvents, expectedEvents);
}
