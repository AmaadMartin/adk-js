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
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const APP_NAME = 'test_app';
const USER_ID = 'user_1';

/** A model that replays one scripted turn per request. */
class ScriptedLlm extends BaseLlm {
  private index = 0;

  constructor(private readonly turns: Part[][]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: this.turns[this.index++]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

const simpleFunction = new FunctionTool({
  name: 'simple_function',
  description: 'Echoes its input string back.',
  parameters: z.object({input_str: z.string()}),
  execute: async ({input_str}) => ({result: input_str}),
});

/**
 * Builds the two scripted turns for one run: a `simple_function` call, then
 * the text `response1`.
 *
 * Every part is rebuilt on each call. A before-tool callback that mutates
 * `args` in place writes through to whatever object it was handed, so a shared
 * constant would leak one test's mutation into the next.
 */
function scriptedTurns(args: Record<string, unknown>): Part[][] {
  return [
    [{functionCall: {name: 'simple_function', args}}],
    [{text: 'response1'}],
  ];
}

/** An event reduced to its author and its one salient part. */
type SimplifiedEvent = [string | undefined, SimplifiedPart];

type SimplifiedPart =
  | string
  | {fc: string; args: Record<string, unknown>}
  | {fr: string; response: Record<string, unknown>};

function simplifyPart(part: Part): SimplifiedPart {
  if (part.functionCall) {
    return {
      fc: part.functionCall.name ?? '',
      args: part.functionCall.args ?? {},
    };
  }
  if (part.functionResponse) {
    return {
      fr: part.functionResponse.name ?? '',
      response: part.functionResponse.response ?? {},
    };
  }
  return part.text ?? '';
}

function simplifyEvents(events: Event[]): SimplifiedEvent[] {
  return events.map(
    (event): SimplifiedEvent => [
      event.author,
      simplifyPart(event.content?.parts?.[0] ?? {}),
    ],
  );
}

async function runAgent(options: {
  turns: Part[][];
  beforeToolCallback?: SingleBeforeToolCallback;
  afterToolCallback?: SingleAfterToolCallback;
}): Promise<Event[]> {
  const runner = new InMemoryRunner({
    agent: new LlmAgent({
      name: 'root_agent',
      model: new ScriptedLlm(options.turns),
      beforeToolCallback: options.beforeToolCallback,
      afterToolCallback: options.afterToolCallback,
      tools: [simpleFunction],
    }),
    appName: APP_NAME,
  });
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: session.id,
    newMessage: {parts: [{text: 'test'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('tool callbacks', () => {
  it('before_tool_callback', async () => {
    const events = await runAgent({
      turns: scriptedTurns({}),
      beforeToolCallback: () => ({test: 'before_tool_callback'}),
    });

    expect(simplifyEvents(events)).toEqual([
      ['root_agent', {fc: 'simple_function', args: {}}],
      [
        'root_agent',
        {fr: 'simple_function', response: {test: 'before_tool_callback'}},
      ],
      ['root_agent', 'response1'],
    ]);
  });

  it('before_tool_callback_noop', async () => {
    const events = await runAgent({
      turns: scriptedTurns({input_str: 'simple_function_call'}),
      beforeToolCallback: () => undefined,
    });

    expect(simplifyEvents(events)).toEqual([
      [
        'root_agent',
        {fc: 'simple_function', args: {input_str: 'simple_function_call'}},
      ],
      [
        'root_agent',
        {fr: 'simple_function', response: {result: 'simple_function_call'}},
      ],
      ['root_agent', 'response1'],
    ]);
  });

  it('before_tool_callback_modify_tool_request', async () => {
    const events = await runAgent({
      turns: scriptedTurns({}),
      beforeToolCallback: ({args}) => {
        args['input_str'] = 'modified_input';
        return undefined;
      },
    });

    expect(simplifyEvents(events)).toEqual([
      ['root_agent', {fc: 'simple_function', args: {}}],
      [
        'root_agent',
        {fr: 'simple_function', response: {result: 'modified_input'}},
      ],
      ['root_agent', 'response1'],
    ]);
  });

  it('after_tool_callback', async () => {
    const events = await runAgent({
      turns: scriptedTurns({input_str: 'simple_function_call'}),
      afterToolCallback: () => ({test: 'after_tool_callback'}),
    });

    expect(simplifyEvents(events)).toEqual([
      [
        'root_agent',
        {fc: 'simple_function', args: {input_str: 'simple_function_call'}},
      ],
      [
        'root_agent',
        {fr: 'simple_function', response: {test: 'after_tool_callback'}},
      ],
      ['root_agent', 'response1'],
    ]);
  });

  it('after_tool_callback_noop', async () => {
    const events = await runAgent({
      turns: scriptedTurns({input_str: 'simple_function_call'}),
      afterToolCallback: () => undefined,
    });

    expect(simplifyEvents(events)).toEqual([
      [
        'root_agent',
        {fc: 'simple_function', args: {input_str: 'simple_function_call'}},
      ],
      [
        'root_agent',
        {fr: 'simple_function', response: {result: 'simple_function_call'}},
      ],
      ['root_agent', 'response1'],
    ]);
  });

  it('after_tool_callback_modify_tool_response', async () => {
    const events = await runAgent({
      turns: scriptedTurns({input_str: 'simple_function_call'}),
      afterToolCallback: ({response}) => {
        response['result'] = 'modified_output';
        return response;
      },
    });

    expect(simplifyEvents(events)).toEqual([
      [
        'root_agent',
        {fc: 'simple_function', args: {input_str: 'simple_function_call'}},
      ],
      [
        'root_agent',
        {fr: 'simple_function', response: {result: 'modified_output'}},
      ],
      ['root_agent', 'response1'],
    ]);
  });
});
