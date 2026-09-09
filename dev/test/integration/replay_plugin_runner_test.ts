/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the replay plugin through a real `Runner`, a real two-agent tree and
 * real fixture files on disk. No network and no live model: each agent gets a
 * scripted model that yields the responses the case recorded.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {ReplayPlugin} from '../../src/integration/replay_plugin.js';
import {
  createCaseDir,
  removeCase,
  writeRecordings,
} from './replay_test_support.js';

const APP_NAME = 'replay-runner-test';
const USER_ID = 'replay-user';
const SESSION_ID = 'replay-session';

/** A model that yields a fixed script, one response per request. */
class ScriptedLlm extends BaseLlm {
  private nextIndex = 0;

  constructor(private readonly script: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support the live path.');
  }

  override async *generateContentAsync(
    _request: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void, void> {
    if (this.nextIndex >= this.script.length) {
      throw new Error('ScriptedLlm ran out of scripted responses.');
    }
    yield this.script[this.nextIndex++];
  }
}

function functionCallResponse(
  name: string,
  args: Record<string, unknown>,
): LlmResponse {
  return {content: {role: 'model', parts: [{functionCall: {name, args}}]}};
}

function textResponse(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

/** Tracks which tools actually executed during a replay. */
interface ToolLog {
  calls: string[];
}

function buildAgents(toolLog: ToolLog): LlmAgent {
  const rollDie = new FunctionTool({
    name: 'roll_die',
    description: 'Rolls a die.',
    parameters: z.object({sides: z.number()}),
    execute: (args: {sides: number}) => {
      toolLog.calls.push(`roll_die:${args.sides}`);
      return {result: 1};
    },
  });
  const flipCoin = new FunctionTool({
    name: 'flip_coin',
    description: 'Flips a coin.',
    parameters: z.object({times: z.number()}),
    execute: (args: {times: number}) => {
      toolLog.calls.push(`flip_coin:${args.times}`);
      return {result: 'live'};
    },
  });

  const agentB = new LlmAgent({
    name: 'agent_b',
    description: 'Flips coins.',
    tools: [flipCoin],
    model: new ScriptedLlm([
      functionCallResponse('flip_coin', {times: 1}),
      textResponse('first turn done'),
      functionCallResponse('flip_coin', {times: 2}),
      textResponse('second turn done'),
    ]),
  });

  return new LlmAgent({
    name: 'agent_a',
    description: 'Rolls dice and hands coin work to agent_b.',
    tools: [rollDie],
    subAgents: [agentB],
    model: new ScriptedLlm([
      functionCallResponse('roll_die', {sides: 6}),
      functionCallResponse('transfer_to_agent', {agentName: 'agent_b'}),
    ]),
  });
}

function recordedCase(coinArgs: Record<string, unknown>) {
  return [
    {
      user_message_index: 0,
      agent_name: 'agent_a',
      tool_recording: {
        tool_call: {id: 'fc-1', name: 'roll_die', args: {sides: 6}},
        tool_response: {id: 'fc-1', name: 'roll_die', response: {result: 4}},
      },
    },
    {
      user_message_index: 0,
      agent_name: 'agent_a',
      tool_recording: {
        tool_call: {
          id: 'fc-2',
          name: 'transfer_to_agent',
          args: {agentName: 'agent_b'},
        },
        tool_response: {
          id: 'fc-2',
          name: 'transfer_to_agent',
          response: {result: 'Transfer queued'},
        },
      },
    },
    {
      user_message_index: 0,
      agent_name: 'agent_b',
      tool_recording: {
        tool_call: {id: 'fc-3', name: 'flip_coin', args: coinArgs},
        tool_response: {
          id: 'fc-3',
          name: 'flip_coin',
          response: {result: 'heads'},
        },
      },
    },
    {
      user_message_index: 1,
      agent_name: 'agent_b',
      tool_recording: {
        tool_call: {id: 'fc-4', name: 'flip_coin', args: {times: 2}},
        tool_response: {
          id: 'fc-4',
          name: 'flip_coin',
          response: {result: 'tails'},
        },
      },
    },
  ];
}

async function replayTurns(
  caseDir: string,
  toolLog: ToolLog,
  turns: string[],
): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    agent: buildAgents(toolLog),
    sessionService,
    plugins: [new ReplayPlugin()],
    appName: APP_NAME,
  });
  await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });

  const events: Event[] = [];
  for (let index = 0; index < turns.length; index++) {
    const iterator = runner.runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: {role: 'user', parts: [{text: turns[index]}]},
      stateDelta: {
        _adk_replay_config: {
          dir: caseDir,
          user_message_index: index,
          streaming_mode: 'none',
        },
      },
    });
    for await (const event of iterator) {
      events.push(event);
    }
  }
  return events;
}

function functionResponses(events: Event[]): Array<Record<string, unknown>> {
  return events.flatMap((event) =>
    (event.content?.parts ?? []).flatMap((part) =>
      part.functionResponse?.response ? [part.functionResponse.response] : [],
    ),
  );
}

describe('ReplayPlugin through a Runner', () => {
  let caseDir: string;
  let toolLog: ToolLog;

  beforeEach(async () => {
    caseDir = await createCaseDir();
    toolLog = {calls: []};
  });

  afterEach(async () => {
    await removeCase(caseDir);
  });

  it('replays two turns across two agents and runs the real tools', async () => {
    await writeRecordings(caseDir, recordedCase({times: 1}));

    const events = await replayTurns(caseDir, toolLog, ['roll', 'again']);

    expect(functionResponses(events)).toEqual([
      {result: 4},
      {result: 'Transfer queued'},
      {result: 'heads'},
      {result: 'tails'},
    ]);
    expect(toolLog.calls).toEqual(['roll_die:6', 'flip_coin:1', 'flip_coin:2']);
  });

  it('reports the mismatch when the recorded args are corrupted', async () => {
    await writeRecordings(caseDir, recordedCase({times: 99}));

    const events = await replayTurns(caseDir, toolLog, ['roll']);

    // The runtime turns a plugin failure into an error event rather than
    // rejecting the run, so the mismatch arrives on the event stream.
    const errorMessages = events.flatMap((event) =>
      event.errorMessage ? [event.errorMessage] : [],
    );
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toContain(
      "Tool args mismatch for agent 'agent_b'",
    );
    expect(errorMessages[0]).toContain('{"times":99}');
    expect(errorMessages[0]).toContain('{"times":1}');
  });
});
