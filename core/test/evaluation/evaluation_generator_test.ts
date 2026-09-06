/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  createEvent,
  createSession,
  EvalConversation,
  FunctionTool,
  generateResponses,
  generateResponsesFromSession,
  generateResponsesFromSessionFile,
  InMemoryArtifactService,
  InMemorySessionService,
  InputValidationError,
  LlmAgent,
  LongRunningFunctionTool,
  NotFoundError,
  SequentialAgent,
  Session,
} from '@google/adk';
import {Part} from '@google/genai';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';
import {ScriptedLlm} from '../workflow/test_helpers.js';

/** The call the scripted model makes when a turn should reach a tool. */
const WEATHER_CALL: Part = {
  functionCall: {id: 'fc-1', name: 'get_weather', args: {city: 'Paris'}},
};

/** The same call again, with the id a second turn would carry. */
const SECOND_WEATHER_CALL: Part = {
  functionCall: {id: 'fc-2', name: 'get_weather', args: {city: 'Paris'}},
};

/** A real tool that records the arguments every call reached it with. */
function weatherTool(calls: Array<{city: string}>): BaseTool {
  return new FunctionTool({
    name: 'get_weather',
    description: 'Returns the weather in a city.',
    parameters: z.object({city: z.string()}),
    execute: (args) => {
      calls.push(args);
      return {sky: 'rain'};
    },
  });
}

/** An agent whose model answers `replies`, repeating the last one. */
function scriptedAgent(
  name: string,
  replies: Array<string | Part>,
  tools: BaseTool[] = [],
): LlmAgent {
  return new LlmAgent({name, model: new ScriptedLlm(replies), tools});
}

describe('generateResponses', () => {
  it('replays every conversation once per repeat, three times by default', async () => {
    const results = await generateResponses({
      evalDataset: [[{query: 'a'}], [{query: 'b'}]],
      rootAgent: scriptedAgent('agent', ['ok']),
    });

    expect(results).toHaveLength(6);
    expect(results.map((conversation) => conversation[0].query)).toEqual([
      'a',
      'b',
      'a',
      'b',
      'a',
      'b',
    ]);
  });

  it('returns nothing when the dataset is replayed zero times', async () => {
    const results = await generateResponses({
      evalDataset: [[{query: 'a'}]],
      rootAgent: scriptedAgent('agent', ['ok']),
      repeatNum: 0,
    });

    expect(results).toEqual([]);
  });

  it('records the final response of every turn', async () => {
    const [conversation] = await generateResponses({
      evalDataset: [[{query: 'q1'}, {query: 'q2'}]],
      rootAgent: scriptedAgent('agent', ['first', 'second']),
      repeatNum: 1,
    });

    expect(conversation.map((turn) => turn.response)).toEqual([
      'first',
      'second',
    ]);
  });

  it('records the tool calls the agent made', async () => {
    const calls: Array<{city: string}> = [];

    const [conversation] = await generateResponses({
      evalDataset: [[{query: 'weather?'}]],
      rootAgent: scriptedAgent(
        'agent',
        [WEATHER_CALL, 'sunny'],
        [weatherTool(calls)],
      ),
      repeatNum: 1,
    });

    expect(conversation[0].actual_tool_use).toEqual([
      {tool_name: 'get_weather', tool_input: {city: 'Paris'}},
    ]);
    expect(conversation[0].response).toBe('sunny');
    expect(calls).toEqual([{city: 'Paris'}]);
  });

  it('records a long-running tool call, which reads as a final response', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: new ScriptedLlm([
        {
          functionCall: {
            id: 'fc-1',
            name: 'ask_user',
            args: {question: 'which city?'},
          },
        },
        'done',
      ]),
      tools: [
        new LongRunningFunctionTool({
          name: 'ask_user',
          description: 'Asks the user a question.',
          parameters: z.object({question: z.string()}),
          execute: () => ({status: 'pending'}),
        }),
      ],
    });

    const [conversation] = await generateResponses({
      evalDataset: [[{query: 'q'}]],
      rootAgent: agent,
      repeatNum: 1,
    });

    expect(conversation[0].actual_tool_use).toEqual([
      {tool_name: 'ask_user', tool_input: {question: 'which city?'}},
    ]);
  });

  it('carries the recorded fields of a turn through to the result', async () => {
    const [conversation] = await generateResponses({
      evalDataset: [
        [
          {
            query: 'q',
            reference: 'the reference answer',
            expected_tool_use: [{tool_name: 'get_weather'}],
          },
        ],
      ],
      rootAgent: scriptedAgent('agent', ['ok']),
      repeatNum: 1,
    });

    expect(conversation[0]).toEqual({
      query: 'q',
      reference: 'the reference answer',
      expected_tool_use: [{tool_name: 'get_weather'}],
      actual_tool_use: [],
      response: 'ok',
    });
  });

  it('leaves the input dataset unchanged and returns a new turn per repeat', async () => {
    const dataset: EvalConversation[] = [[{query: 'a'}]];

    const results = await generateResponses({
      evalDataset: dataset,
      rootAgent: scriptedAgent('agent', ['ok']),
      repeatNum: 2,
    });

    expect(dataset[0][0]).toEqual({query: 'a'});
    expect(results[0][0]).not.toBe(dataset[0][0]);
    expect(results[0][0]).not.toBe(results[1][0]);
    expect(results[0][0].response).toBe('ok');
  });

  it('answers a mocked tool call from the dataset instead of running the tool', async () => {
    const calls: Array<{city: string}> = [];

    const [conversation] = await generateResponses({
      evalDataset: [
        [
          {
            query: 'weather?',
            expected_tool_use: [
              {
                tool_name: 'get_weather',
                tool_input: {city: 'Paris'},
                mock_tool_output: null,
              },
            ],
          },
        ],
      ],
      rootAgent: scriptedAgent(
        'agent',
        [WEATHER_CALL, 'done'],
        [weatherTool(calls)],
      ),
      repeatNum: 1,
    });

    expect(calls).toEqual([]);
    expect(conversation[0].actual_tool_use).toEqual([
      {tool_name: 'get_weather', tool_input: {city: 'Paris'}},
    ]);
    expect(conversation[0].response).toBe('done');
  });

  it('treats a recorded output of undefined as a mock, because the key is present', async () => {
    const calls: Array<{city: string}> = [];

    await generateResponses({
      evalDataset: [
        [
          {
            query: 'weather?',
            expected_tool_use: [
              {
                tool_name: 'get_weather',
                tool_input: {city: 'Paris'},
                mock_tool_output: undefined,
              },
            ],
          },
        ],
      ],
      rootAgent: scriptedAgent(
        'agent',
        [WEATHER_CALL, 'done'],
        [weatherTool(calls)],
      ),
      repeatNum: 1,
    });

    expect(calls).toEqual([]);
  });

  it('matches a call that takes no arguments against a mock that records none', async () => {
    let ran = false;
    const pingTool = new FunctionTool({
      name: 'ping',
      description: 'Answers a ping.',
      execute: () => {
        ran = true;
        return {pong: true};
      },
    });

    await generateResponses({
      evalDataset: [
        [
          {
            query: 'ping?',
            expected_tool_use: [
              {tool_name: 'ping', mock_tool_output: {pong: false}},
            ],
          },
        ],
      ],
      rootAgent: scriptedAgent(
        'agent',
        [{functionCall: {id: 'fc-ping', name: 'ping'}}, 'done'],
        [pingTool],
      ),
      repeatNum: 1,
    });

    expect(ran).toBe(false);
  });

  it('runs the real tool when the recorded arguments differ', async () => {
    const calls: Array<{city: string}> = [];

    await generateResponses({
      evalDataset: [
        [
          {
            query: 'weather?',
            expected_tool_use: [
              {
                tool_name: 'get_weather',
                tool_input: {city: 'London'},
                mock_tool_output: {sky: 'clear'},
              },
            ],
          },
        ],
      ],
      rootAgent: scriptedAgent(
        'agent',
        [WEATHER_CALL, 'done'],
        [weatherTool(calls)],
      ),
      repeatNum: 1,
    });

    expect(calls).toEqual([{city: 'Paris'}]);
  });

  it('mocks a recorded call once, then falls through to the real tool', async () => {
    const calls: Array<{city: string}> = [];

    await generateResponses({
      evalDataset: [
        [
          {
            query: 'weather?',
            expected_tool_use: [
              {
                tool_name: 'get_weather',
                tool_input: {city: 'Paris'},
                mock_tool_output: {sky: 'clear'},
              },
            ],
          },
          {query: 'and again?'},
        ],
      ],
      rootAgent: scriptedAgent(
        'agent',
        [WEATHER_CALL, 'first', SECOND_WEATHER_CALL, 'second'],
        [weatherTool(calls)],
      ),
      repeatNum: 1,
    });

    expect(calls).toEqual([{city: 'Paris'}]);
  });

  it('installs the mock callback on the sub-agent that owns the tool', async () => {
    const child = scriptedAgent('child', ['ok'], [weatherTool([])]);
    const root = new LlmAgent({
      name: 'root',
      model: new ScriptedLlm(['ok']),
      subAgents: [child],
    });

    await generateResponses({
      evalDataset: [
        [
          {
            query: 'q',
            expected_tool_use: [
              {tool_name: 'get_weather', mock_tool_output: {sky: 'clear'}},
            ],
          },
        ],
      ],
      rootAgent: root,
      repeatNum: 1,
    });

    expect(child.beforeToolCallback).toBeDefined();
    expect(root.beforeToolCallback).toBeUndefined();
  });

  it('installs no callback when the dataset mocks nothing', async () => {
    const agent = scriptedAgent('agent', ['ok'], [weatherTool([])]);

    await generateResponses({
      evalDataset: [
        [{query: 'q', expected_tool_use: [{tool_name: 'get_weather'}]}],
      ],
      rootAgent: agent,
      repeatNum: 1,
    });

    expect(agent.beforeToolCallback).toBeUndefined();
  });

  it('ignores a recorded output whose tool has no name', async () => {
    const calls: Array<{city: string}> = [];
    const agent = scriptedAgent(
      'agent',
      [WEATHER_CALL, 'done'],
      [weatherTool(calls)],
    );

    await generateResponses({
      evalDataset: [
        [{query: 'q', expected_tool_use: [{mock_tool_output: {}}]}],
      ],
      rootAgent: agent,
      repeatNum: 1,
    });

    expect(agent.beforeToolCallback).toBeUndefined();
    expect(calls).toEqual([{city: 'Paris'}]);
  });

  it('mocks a tool owned by an LLM agent under a workflow agent', async () => {
    const calls: Array<{city: string}> = [];
    const child = scriptedAgent(
      'child',
      [WEATHER_CALL, 'done'],
      [weatherTool(calls)],
    );
    const root = new SequentialAgent({name: 'root', subAgents: [child]});

    const [conversation] = await generateResponses({
      evalDataset: [
        [
          {
            query: 'weather?',
            expected_tool_use: [
              {
                tool_name: 'get_weather',
                tool_input: {city: 'Paris'},
                mock_tool_output: {sky: 'clear'},
              },
            ],
          },
        ],
      ],
      rootAgent: root,
      repeatNum: 1,
    });

    expect(child.beforeToolCallback).toBeDefined();
    expect(calls).toEqual([]);
    expect(conversation[0].response).toBe('done');
  });

  it('evaluates the sub-agent the caller names', async () => {
    const child = scriptedAgent('child', ['from the child']);
    const root = new LlmAgent({
      name: 'root',
      model: new ScriptedLlm(['from the root']),
      subAgents: [child],
    });

    const [conversation] = await generateResponses({
      evalDataset: [[{query: 'q'}]],
      rootAgent: root,
      agentName: 'child',
      repeatNum: 1,
    });

    expect(conversation[0].response).toBe('from the child');
  });

  it('rejects with NotFoundError when no agent carries that name', async () => {
    const call = () =>
      generateResponses({
        evalDataset: [[{query: 'q'}]],
        rootAgent: scriptedAgent('root', ['ok']),
        agentName: 'missing',
      });

    await expect(call()).rejects.toThrow(NotFoundError);
    await expect(call()).rejects.toThrow('Sub-Agent `missing` not found.');
  });

  it('runs an async reset function once per replay', async () => {
    const resetFunc = vi.fn(async () => {});

    await generateResponses({
      evalDataset: [[{query: 'a'}], [{query: 'b'}]],
      rootAgent: scriptedAgent('agent', ['ok']),
      repeatNum: 2,
      resetFunc,
    });

    expect(resetFunc).toHaveBeenCalledTimes(4);
  });

  it('runs a synchronous reset function before the first turn', async () => {
    const order: string[] = [];
    const agent = scriptedAgent('agent', ['ok']);

    const [conversation] = await generateResponses({
      evalDataset: [[{query: 'a'}]],
      rootAgent: agent,
      repeatNum: 1,
      resetFunc: () => {
        order.push('reset');
      },
    });

    expect(order).toEqual(['reset']);
    expect(conversation[0].response).toBe('ok');
  });

  it('creates the session under the default app and user', async () => {
    const sessionService = new InMemorySessionService();
    const createSessionSpy = vi.spyOn(sessionService, 'createSession');

    await generateResponses({
      evalDataset: [[{query: 'a'}]],
      rootAgent: scriptedAgent('agent', ['ok']),
      repeatNum: 1,
      sessionService,
    });

    expect(createSessionSpy).toHaveBeenCalledWith({
      appName: 'EvaluationGenerator',
      userId: 'test_user_id',
      state: {},
      sessionId: expect.any(String),
    });
  });

  it('creates the session under the app, user and state the caller supplies', async () => {
    const sessionService = new InMemorySessionService();

    await generateResponses({
      evalDataset: [[{query: 'a'}]],
      rootAgent: scriptedAgent('agent', ['ok']),
      repeatNum: 1,
      initialSession: {
        appName: 'my_app',
        userId: 'user_1',
        state: {seen: true},
      },
      sessionService,
    });

    const {sessions} = await sessionService.listSessions({
      appName: 'my_app',
      userId: 'user_1',
    });
    expect(sessions).toHaveLength(1);
    const session = await sessionService.getSession({
      appName: 'my_app',
      userId: 'user_1',
      sessionId: sessions[0].id,
    });
    expect(session?.state).toMatchObject({seen: true});
  });

  it('writes artifacts to the artifact service the caller supplies', async () => {
    const artifactService = new InMemoryArtifactService();
    const sessionService = new InMemorySessionService();
    const savingTool = new FunctionTool({
      name: 'get_weather',
      description: 'Saves the forecast as an artifact.',
      parameters: z.object({city: z.string()}),
      execute: async (args, context) => {
        await context?.saveArtifact(`${args.city}.txt`, {text: 'rain'});
        return {saved: true};
      },
    });

    await generateResponses({
      evalDataset: [[{query: 'weather?'}]],
      rootAgent: scriptedAgent('agent', [WEATHER_CALL, 'done'], [savingTool]),
      repeatNum: 1,
      initialSession: {appName: 'my_app', userId: 'user_1'},
      artifactService,
      sessionService,
    });

    const {sessions} = await sessionService.listSessions({
      appName: 'my_app',
      userId: 'user_1',
    });
    const keys = await artifactService.listArtifactKeys({
      appName: 'my_app',
      userId: 'user_1',
      sessionId: sessions[0].id,
    });
    expect(keys).toEqual(['Paris.txt']);
  });
});

/** A session holding one answered turn and one unanswered turn. */
function recordedSession(): Session {
  return createSession({
    id: 'session-1',
    appName: 'my_app',
    userId: 'user_1',
    events: [
      createEvent({
        author: 'user',
        invocationId: 'inv-1',
        content: {role: 'user', parts: [{text: 'weather?'}]},
      }),
      createEvent({
        author: 'agent',
        invocationId: 'inv-1',
        content: {role: 'model', parts: [WEATHER_CALL]},
      }),
      createEvent({
        author: 'agent',
        invocationId: 'inv-1',
        content: {role: 'model', parts: [{text: 'It is raining.'}]},
      }),
      createEvent({
        author: 'user',
        invocationId: 'inv-2',
        content: {role: 'user', parts: [{text: 'thanks'}]},
      }),
    ],
  });
}

describe('generateResponsesFromSession', () => {
  it('fills a turn in from the events of the matching invocation', () => {
    const [conversation] = generateResponsesFromSession(recordedSession(), [
      [{query: 'weather?'}],
    ]);

    expect(conversation[0].actual_tool_use).toEqual([
      {tool_name: 'get_weather', tool_input: {city: 'Paris'}},
    ]);
    expect(conversation[0].response).toBe('It is raining.');
  });

  it('leaves a turn empty when the session holds no such query', () => {
    const [conversation] = generateResponsesFromSession(recordedSession(), [
      [{query: 'never asked'}],
    ]);

    expect(conversation[0].actual_tool_use).toEqual([]);
    expect(conversation[0].response).toBeUndefined();
  });

  it('skips an event that carries no content', () => {
    const session = createSession({
      id: 'session-1',
      appName: 'my_app',
      events: [
        createEvent({
          author: 'user',
          invocationId: 'inv-1',
          content: {role: 'user', parts: [{text: 'weather?'}]},
        }),
        createEvent({author: 'agent', invocationId: 'inv-1'}),
        createEvent({
          author: 'agent',
          invocationId: 'inv-1',
          content: {role: 'model', parts: []},
        }),
        createEvent({
          author: 'agent',
          invocationId: 'inv-1',
          content: {role: 'model', parts: [{text: 'It is raining.'}]},
        }),
      ],
    });

    const [conversation] = generateResponsesFromSession(session, [
      [{query: 'weather?'}],
    ]);

    expect(conversation[0].response).toBe('It is raining.');
  });

  it('ignores the events of another invocation', () => {
    const session = createSession({
      id: 'session-1',
      appName: 'my_app',
      events: [
        createEvent({
          author: 'user',
          invocationId: 'inv-1',
          content: {role: 'user', parts: [{text: 'weather?'}]},
        }),
        createEvent({
          author: 'agent',
          invocationId: 'inv-2',
          content: {role: 'model', parts: [{text: 'another turn'}]},
        }),
      ],
    });

    const [conversation] = generateResponsesFromSession(session, [
      [{query: 'weather?'}],
    ]);

    expect(conversation[0].response).toBeUndefined();
  });

  it('does not read the user event as the response', () => {
    const [conversation] = generateResponsesFromSession(recordedSession(), [
      [{query: 'thanks'}],
    ]);

    expect(conversation[0].response).toBeUndefined();
    expect(conversation[0].actual_tool_use).toEqual([]);
  });

  it('leaves the input dataset unchanged', () => {
    const dataset: EvalConversation[] = [[{query: 'weather?'}]];

    const results = generateResponsesFromSession(recordedSession(), dataset);

    expect(dataset[0][0]).toEqual({query: 'weather?'});
    expect(results[0][0]).not.toBe(dataset[0][0]);
  });

  it('fills in every conversation of the dataset', () => {
    const results = generateResponsesFromSession(recordedSession(), [
      [{query: 'weather?'}],
      [{query: 'thanks'}],
    ]);

    expect(results).toHaveLength(2);
    expect(results[0][0].response).toBe('It is raining.');
    expect(results[1][0].response).toBeUndefined();
  });

  it('rejects a turn whose query is not a string', () => {
    // A dataset read from a *.test.json file carries no types.
    const dataset: EvalConversation[] = JSON.parse('[[{"query": 42}]]');

    expect(() =>
      generateResponsesFromSession(recordedSession(), dataset),
    ).toThrow(InputValidationError);
  });
});

describe('generateResponsesFromSessionFile', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'adk-eval-'));
  });

  afterAll(async () => {
    await rm(directory, {recursive: true, force: true});
  });

  /** Writes `contents` to a file of the test's own temporary directory. */
  async function writeSessionFile(
    name: string,
    contents: string,
  ): Promise<string> {
    const path = join(directory, name);
    await writeFile(path, contents, 'utf-8');
    return path;
  }

  it('annotates from a session file adk-python wrote', async () => {
    const path = await writeSessionFile(
      'python_session.json',
      JSON.stringify({
        id: 'session-1',
        app_name: 'my_app',
        user_id: 'user_1',
        events: [
          {
            author: 'user',
            invocation_id: 'inv-1',
            content: {role: 'user', parts: [{text: 'weather?'}]},
          },
          {
            author: 'agent',
            invocation_id: 'inv-1',
            content: {
              role: 'model',
              parts: [
                {
                  function_call: {
                    id: 'fc-1',
                    name: 'get_weather',
                    // A snake_case argument name must survive the read.
                    args: {city_name: 'Paris'},
                  },
                },
              ],
            },
          },
          {
            author: 'agent',
            invocation_id: 'inv-1',
            content: {role: 'model', parts: [{text: 'It is raining.'}]},
          },
          {
            author: 'agent',
            invocation_id: 'inv-2',
            content: {role: 'model', parts: [{text: 'another turn'}]},
          },
        ],
      }),
    );

    const [conversation] = await generateResponsesFromSessionFile(path, [
      [{query: 'weather?'}],
    ]);

    expect(conversation[0].actual_tool_use).toEqual([
      {tool_name: 'get_weather', tool_input: {city_name: 'Paris'}},
    ]);
    expect(conversation[0].response).toBe('It is raining.');
  });

  it('annotates from a session file adk-js wrote', async () => {
    const session = createSession({
      id: 'session-1',
      appName: 'my_app',
      events: [
        createEvent({
          author: 'user',
          invocationId: 'inv-1',
          content: {role: 'user', parts: [{text: 'weather?'}]},
        }),
        createEvent({
          author: 'agent',
          invocationId: 'inv-1',
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'fc-1',
                  name: 'get_weather',
                  // A snake_case argument name must survive the read.
                  args: {city_name: 'Paris'},
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'agent',
          invocationId: 'inv-1',
          content: {role: 'model', parts: [{text: 'It is raining.'}]},
        }),
      ],
    });
    const path = await writeSessionFile(
      'js_session.json',
      JSON.stringify(session),
    );

    const [conversation] = await generateResponsesFromSessionFile(path, [
      [{query: 'weather?'}],
    ]);

    expect(conversation[0].actual_tool_use).toEqual([
      {tool_name: 'get_weather', tool_input: {city_name: 'Paris'}},
    ]);
    expect(conversation[0].response).toBe('It is raining.');
  });

  it('reads a session file that holds text outside ASCII', async () => {
    const query = 'Como está o tempo? 🌦️ 天気は？';
    const answer = 'Está a chover. ☔ 雨です。';
    const path = await writeSessionFile(
      'unicode_session.json',
      JSON.stringify({
        events: [
          {
            author: 'user',
            invocation_id: 'inv-1',
            content: {role: 'user', parts: [{text: query}]},
          },
          {
            author: 'agent',
            invocation_id: 'inv-1',
            content: {role: 'model', parts: [{text: answer}]},
          },
        ],
      }),
    );

    const [conversation] = await generateResponsesFromSessionFile(path, [
      [{query}],
    ]);

    expect(conversation[0].response).toBe(answer);
  });

  it('rejects a session file that holds no events array', async () => {
    const path = await writeSessionFile('no_events.json', '{"id": "s1"}');

    await expect(
      generateResponsesFromSessionFile(path, [[{query: 'weather?'}]]),
    ).rejects.toThrow(InputValidationError);
  });

  it('rejects a session file that does not exist', async () => {
    const path = join(directory, 'missing.json');

    await expect(
      generateResponsesFromSessionFile(path, [[{query: 'weather?'}]]),
    ).rejects.toThrow('ENOENT');
  });
});
