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
  LlmAgentConfig,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {Part, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const APP_NAME = 'output_save_app';

const OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    message: {type: Type.STRING},
    confidence: {type: Type.NUMBER},
  },
};

/** A model that replays one canned response per call. */
class ScriptedLlm extends BaseLlm {
  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  private call = 0;

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield this.responses[Math.min(this.call++, this.responses.length - 1)];
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('the scripted model has no live mode'));
  }
}

function modelTurn(...parts: Part[]): LlmResponse {
  return {content: {role: 'model', parts}};
}

/**
 * Runs `agent` for one user message and returns every event it emitted.
 *
 * The agent's own events are the only place `outputKey` is written: the caller
 * appends them to the session, so a test can assert on either.
 */
async function runAgent(config: LlmAgentConfig): Promise<Event[]> {
  const agent = new LlmAgent(config);
  const sessionService = new InMemorySessionService();
  const runner = new Runner({appName: APP_NAME, agent, sessionService});
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: 'user',
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'go'}]},
  })) {
    events.push(event);
  }
  return events;
}

/** The value written under `key`, or `undefined` if no event wrote one. */
function savedValue(events: Event[], key: string): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    if (key in events[i].actions.stateDelta) {
      return events[i].actions.stateDelta[key];
    }
  }
  return undefined;
}

/** Whether any event wrote `key` at all, even as a falsy value. */
function wroteKey(events: Event[], key: string): boolean {
  return events.some((event) => key in event.actions.stateDelta);
}

describe('LlmAgent outputKey saving', () => {
  it('saves the text of the final response', async () => {
    const events = await runAgent({
      name: 'agent',
      model: new ScriptedLlm([modelTurn({text: 'Test response'})]),
      outputKey: 'result',
    });

    expect(savedValue(events, 'result')).toBe('Test response');
  });

  it('writes nothing when no outputKey is configured', async () => {
    const events = await runAgent({
      name: 'agent',
      model: new ScriptedLlm([modelTurn({text: 'Test response'})]),
    });

    expect(wroteKey(events, 'result')).toBe(false);
  });

  it('writes nothing on a partial event', async () => {
    const events = await runAgent({
      name: 'agent',
      model: new ScriptedLlm([
        {content: {role: 'model', parts: [{text: 'Partial'}]}, partial: true},
      ]),
      outputKey: 'result',
      // A schema turns the streaming accumulator off, so this pins the
      // partial-event guard alone.
      outputSchema: OUTPUT_SCHEMA,
    });

    expect(wroteKey(events, 'result')).toBe(false);
  });

  it('concatenates several text parts', async () => {
    const events = await runAgent({
      name: 'agent',
      model: new ScriptedLlm([
        modelTurn({text: 'Hello '}, {text: 'world'}, {text: '!'}),
      ]),
      outputKey: 'result',
    });

    expect(savedValue(events, 'result')).toBe('Hello world!');
  });

  it('leaves the thought parts out of the saved text', async () => {
    const events = await runAgent({
      name: 'agent',
      model: new ScriptedLlm([
        modelTurn(
          {text: 'Let me think about it. ', thought: true},
          {text: 'The answer is 42.'},
        ),
      ]),
      outputKey: 'result',
    });

    expect(savedValue(events, 'result')).toBe('The answer is 42.');
  });

  it('writes nothing when the only text is a thought', async () => {
    const events = await runAgent({
      name: 'agent',
      model: new ScriptedLlm([modelTurn({text: 'Thinking.', thought: true})]),
      outputKey: 'result',
    });

    expect(wroteKey(events, 'result')).toBe(false);
  });

  it('saves an empty string when the model returns empty text', async () => {
    const events = await runAgent({
      name: 'agent',
      model: new ScriptedLlm([modelTurn({text: ''})]),
      outputKey: 'result',
    });

    expect(wroteKey(events, 'result')).toBe(true);
    expect(savedValue(events, 'result')).toBe('');
  });

  it('skips an intermediate text turn in task mode', async () => {
    const events = await runAgent({
      name: 'agent',
      mode: 'task',
      model: new ScriptedLlm([
        modelTurn({text: 'Please describe your data domain.'}),
      ]),
      outputKey: 'result',
      outputSchema: OUTPUT_SCHEMA,
    });

    expect(wroteKey(events, 'result')).toBe(false);
  });

  it('keeps the value an afterToolCallback set on a response-only event', async () => {
    // The tool skips summarization, so its function-response event is the
    // final response of the turn. It has no text, so the value the callback
    // stored must survive.
    const tool = new FunctionTool({
      name: 'lookup',
      description: 'Returns rows and stores them under the output key.',
      parameters: z.object({}),
      execute: async () => ({status: 'success'}),
    });

    const events = await runAgent({
      name: 'agent',
      model: new ScriptedLlm([
        modelTurn({functionCall: {name: 'lookup', args: {}}}),
      ]),
      outputKey: 'result',
      tools: [tool],
      afterToolCallback: ({context, response}) => {
        context.actions.skipSummarization = true;
        context.state.set('result', [1, 2, 3]);
        return response;
      },
    });

    expect(savedValue(events, 'result')).toEqual([1, 2, 3]);
  });

  it('writes nothing when a schema is set and the final chunk is blank', async () => {
    const events = await runAgent({
      name: 'agent',
      model: new ScriptedLlm([modelTurn({text: '   '})]),
      outputKey: 'result',
      outputSchema: OUTPUT_SCHEMA,
    });

    expect(wroteKey(events, 'result')).toBe(false);
  });

  it('saves the output when beforeAgentCallback short-circuits the agent', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: new ScriptedLlm([modelTurn({text: 'never reached'})]),
      outputKey: 'result',
      beforeAgentCallback: () => ({
        role: 'model',
        parts: [{text: 'cached answer'}],
      }),
    });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({appName: APP_NAME, agent, sessionService});
    const created = await sessionService.createSession({
      appName: APP_NAME,
      userId: 'user',
    });

    for await (const _ of runner.runAsync({
      userId: created.userId,
      sessionId: created.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      // Drain: the assertion is on the session state the run leaves behind.
    }

    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: created.userId,
      sessionId: created.id,
    });
    expect(session?.state['result']).toBe('cached answer');
  });
});
