/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
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
  Session,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const APP_NAME = 'streaming_output_app';

/**
 * A model that replays one canned list of responses per call, so a test can
 * reproduce a streaming turn without a network. The last turn repeats once the
 * script is exhausted.
 */
class ScriptedTurnsLlm extends BaseLlm {
  constructor(private readonly turns: LlmResponse[][]) {
    super({model: 'scripted-turns-llm'});
  }

  private turn = 0;

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const responses = this.turns[Math.min(this.turn++, this.turns.length - 1)];
    for (const response of responses) {
      yield response;
    }
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('the scripted model has no live mode'));
  }
}

function partialText(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, partial: true};
}

function text(value: string): LlmResponse {
  return {content: {role: 'model', parts: [{text: value}]}};
}

function textAndCall(value: string): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [{text: value}, {functionCall: {name: 't', args: {}}}],
    },
  };
}

const tool = new FunctionTool({
  name: 't',
  description: 'A tool the model calls between text segments.',
  parameters: z.object({}),
  execute: async () => ({ok: true}),
});

/**
 * The event sequence an SSE streaming turn with tool calls produces: partial
 * chunks, then a non-partial event carrying the same text alongside a function
 * call, three times over.
 */
const STREAMED_TURNS: LlmResponse[][] = [
  [
    partialText('Intro one. '),
    partialText('Intro two.'),
    textAndCall('Intro one. Intro two.'),
  ],
  [partialText('Progress.'), textAndCall('Progress.')],
  [
    partialText('Conclusion one. '),
    partialText('Conclusion two.'),
    text('Conclusion one. Conclusion two.'),
  ],
];

async function runAgent(agent: LlmAgent): Promise<Session> {
  const sessionService = new InMemorySessionService();
  const runner = new Runner({appName: APP_NAME, agent, sessionService});
  const created = await sessionService.createSession({
    appName: APP_NAME,
    userId: 'user',
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: created.userId,
    sessionId: created.id,
    newMessage: {role: 'user', parts: [{text: 'go'}]},
  })) {
    events.push(event);
  }
  const session = await sessionService.getSession({
    appName: APP_NAME,
    userId: created.userId,
    sessionId: created.id,
  });
  if (!session) {
    expect.fail('the session disappeared during the run');
  }
  return session;
}

describe('LlmAgent outputKey accumulation across a streaming turn', () => {
  it('keeps every non-partial text segment around the tool calls', async () => {
    const agent = new LlmAgent({
      name: 'writer',
      model: new ScriptedTurnsLlm(STREAMED_TURNS),
      outputKey: 'final_output',
      tools: [tool],
    });

    const session = await runAgent(agent);

    expect(session.state['final_output']).toBe(
      'Intro one. Intro two.Progress.Conclusion one. Conclusion two.',
    );
  });

  it('writes nothing when the agent is in task mode', async () => {
    const agent = new LlmAgent({
      name: 'writer',
      mode: 'task',
      model: new ScriptedTurnsLlm(STREAMED_TURNS),
      outputKey: 'final_output',
      tools: [tool],
    });

    const session = await runAgent(agent);

    expect(session.state).not.toHaveProperty('final_output');
  });

  it('leaves accumulation off when an output schema is declared', async () => {
    // With a schema the value has to be one parseable document, so the
    // segments must not be concatenated. Only the final chunk is saved.
    const agent = new LlmAgent({
      name: 'writer',
      model: new ScriptedTurnsLlm([
        [partialText('{"answer"'), partialText(': "42"}'), text('{}')],
        [text('{"answer": "42"}')],
      ]),
      outputKey: 'final_output',
      outputSchema: {
        type: Type.OBJECT,
        properties: {answer: {type: Type.STRING}},
      },
    });

    const session = await runAgent(agent);

    expect(session.state['final_output']).toEqual({});
  });

  it('ignores a text segment another agent authored', async () => {
    // The sub-agent answers after the transfer, so its text must not land in
    // the parent's outputKey.
    const child = new LlmAgent({
      name: 'child',
      model: new ScriptedTurnsLlm([[text('Child answer.')]]),
    });
    const parent = new LlmAgent({
      name: 'parent',
      model: new ScriptedTurnsLlm([
        [
          {
            content: {
              role: 'model',
              parts: [
                {text: 'Handing over. '},
                {
                  functionCall: {
                    name: 'transfer_to_agent',
                    args: {agentName: 'child'},
                  },
                },
              ],
            },
          },
        ],
      ]),
      outputKey: 'final_output',
      subAgents: [child],
    });

    const session = await runAgent(parent);

    expect(session.state['final_output']).toBe('Handing over. ');
  });
});
