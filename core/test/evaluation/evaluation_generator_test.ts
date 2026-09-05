/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BasePlugin,
  Context,
  convertEventsToEvalInvocations,
  createEvent,
  CreateEventParams,
  EvalCase,
  EvalRow,
  EvalSet,
  Event,
  generateInferencesFromAgentModule,
  generateInferencesFromRootAgent,
  generateResponses,
  generateResponsesFromSession,
  getAllToolCalls,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  Invocation,
  InvocationContext,
  InvocationEvent,
  isInvocationEvents,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  NextUserMessage,
  PluginManager,
  Runner,
  Session,
  UserSimulator,
  UserSimulatorStatus,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {beforeEach, describe, expect, it} from 'vitest';

import {
  buildEvalRunnerConfig,
  collectEventsByInvocationId,
  generateInferencesForSingleUserInvocation,
  getAppDetailsByInvocationId,
  processQueryWithSession,
  toInstructionText,
} from '../../src/evaluation/evaluation_generator.js';
import {RequestIntercepterPlugin} from '../../src/evaluation/request_intercepter_plugin.js';
import {isEvent} from '../../src/events/event.js';

import {ScriptedLlm} from './test_helpers.js';

const TESTDATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testdata',
);

function fixtureModulePath(fileName: string): string {
  return pathToFileURL(path.join(TESTDATA_DIR, fileName)).href;
}

function buildEvent(
  author: string,
  parts: Part[],
  invocationId: string,
  extra: CreateEventParams = {},
): Event {
  return createEvent({
    author,
    invocationId,
    content: {parts},
    ...extra,
  });
}

/** Replays a fixed list of user turns, then signals the conversation is over. */
class ScriptedUserSimulator implements UserSimulator {
  /** The event list handed to the simulator on each call, in call order. */
  readonly receivedEvents: Event[][] = [];

  private turn = 0;

  constructor(
    private readonly messages: string[],
    private readonly onCall?: (events: Event[]) => void,
  ) {}

  async getNextUserMessage(events: Event[]): Promise<NextUserMessage> {
    this.receivedEvents.push(events);
    this.onCall?.(events);
    if (this.turn >= this.messages.length) {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    }
    const text = this.messages[this.turn];
    this.turn++;
    return {
      status: UserSimulatorStatus.SUCCESS,
      userMessage: {role: 'user', parts: [{text}]},
    };
  }
}

/** A plugin the caller owns, used to assert how eval merges plugin lists. */
class SpyPlugin extends BasePlugin {}

function createScriptedAgent(name: string, replies: string[]): LlmAgent {
  return new LlmAgent({name, model: new ScriptedLlm(replies)});
}

async function createCallbackContext(): Promise<Context> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'eval_app',
    userId: 'eval_user',
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session,
      pluginManager: new PluginManager(),
    }),
  });
}

/**
 * Pushes a request through the real intercepter and returns the metadata that
 * identifies it, so a test event can be stamped exactly as a live run would.
 */
async function interceptRequest(
  intercepter: RequestIntercepterPlugin,
  llmRequest: LlmRequest,
): Promise<Record<string, unknown>> {
  const callbackContext = await createCallbackContext();
  await intercepter.beforeModelCallback({callbackContext, llmRequest});
  const llmResponse: LlmResponse = {};
  await intercepter.afterModelCallback({callbackContext, llmResponse});
  return llmResponse.customMetadata ?? {};
}

/** Returns the invocation's recorded events, failing if it holds none. */
function intermediateEvents(invocation: Invocation): InvocationEvent[] {
  const intermediateData = invocation.intermediateData;
  if (intermediateData === undefined || !isInvocationEvents(intermediateData)) {
    expect.fail('the invocation carries no invocation events');
  }
  return intermediateData.invocationEvents;
}

describe('convertEventsToEvalInvocations', () => {
  it('returns nothing for no events', () => {
    expect(convertEventsToEvalInvocations([])).toEqual([]);
  });

  it('pairs a user turn with the agent text response', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{text: 'Hi there!'}], 'inv1'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    expect(invocations[0].invocationId).toBe('inv1');
    expect(invocations[0].userContent.parts?.[0].text).toBe('Hello');
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('Hi there!');
    expect(intermediateEvents(invocations[0])).toHaveLength(0);
  });

  it('takes the user timestamp as the invocation timestamp', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1', {timestamp: 1234}),
      buildEvent('agent', [{text: 'Hi'}], 'inv1', {timestamp: 5678}),
    ];

    expect(convertEventsToEvalInvocations(events)[0].creationTimestamp).toBe(
      1234,
    );
  });

  it('defaults to empty user content when the turn has none', () => {
    const events = [buildEvent('agent', [{text: 'Unprompted'}], 'inv1')];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(invocation.userContent).toEqual({parts: []});
    expect(invocation.creationTimestamp).toBe(0);
    expect(invocation.appDetails).toBeUndefined();
  });

  it('skips a user event that carries no content', () => {
    const events = [
      createEvent({author: 'user', invocationId: 'inv1', timestamp: 4242}),
      buildEvent('agent', [{text: 'Unprompted'}], 'inv1'),
    ];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(invocation.userContent).toEqual({parts: []});
    expect(invocation.creationTimestamp).toBe(0);
  });

  it('keeps the text response over a trailing audio-only event', () => {
    const events = [
      buildEvent('user', [{text: 'Hi'}], 'inv1'),
      buildEvent('agent', [{text: 'Hello there.'}], 'inv1'),
      buildEvent(
        'agent',
        [{inlineData: {mimeType: 'audio/pcm', data: 'ZmFrZS1hdWRpbw=='}}],
        'inv1',
      ),
    ];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(invocation.finalResponse?.parts?.[0].text).toBe('Hello there.');
    const intermediate = intermediateEvents(invocation);
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].content?.parts?.[0].inlineData?.data).toBe(
      'ZmFrZS1hdWRpbw==',
    );
  });

  it('prefers a later text response over an earlier audio-only one', () => {
    const events = [
      buildEvent('user', [{text: 'Hi'}], 'inv1'),
      buildEvent(
        'agent',
        [{inlineData: {mimeType: 'audio/pcm', data: 'ZmFrZS1hdWRpbw=='}}],
        'inv1',
      ),
      buildEvent('agent', [{text: 'Hello there.'}], 'inv1'),
    ];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(invocation.finalResponse?.parts?.[0].text).toBe('Hello there.');
    const intermediate = intermediateEvents(invocation);
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].content?.parts?.[0].inlineData?.data).toBe(
      'ZmFrZS1hdWRpbw==',
    );
  });

  it('replaces an earlier text response with a later one', () => {
    const events = [
      buildEvent('user', [{text: 'Hi'}], 'inv1'),
      buildEvent('agent', [{text: 'First.'}], 'inv1'),
      buildEvent('agent', [{text: 'Second.'}], 'inv1'),
    ];

    expect(
      convertEventsToEvalInvocations(events)[0].finalResponse?.parts?.[0].text,
    ).toBe('Second.');
  });

  it('reports a tool-only turn with no final response', () => {
    const events = [
      buildEvent('user', [{text: 'what is the weather?'}], 'inv1'),
      buildEvent(
        'agent',
        [{functionCall: {name: 'get_weather', args: {}}}],
        'inv1',
      ),
    ];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(invocation.userContent.parts?.[0].text).toBe('what is the weather?');
    expect(invocation.finalResponse).toBeUndefined();
    const intermediate = intermediateEvents(invocation);
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].author).toBe('agent');
    expect(intermediate[0].content?.parts?.[0].functionCall?.name).toBe(
      'get_weather',
    );
  });

  it('reports the tool call alongside the text response', () => {
    const events = [
      buildEvent('user', [{text: 'what is the weather?'}], 'inv1'),
      buildEvent(
        'agent',
        [{functionCall: {name: 'get_weather', args: {}}}],
        'inv1',
      ),
      buildEvent('agent', [{text: 'It is sunny in SF.'}], 'inv1'),
    ];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(invocation.finalResponse?.parts?.[0].text).toBe(
      'It is sunny in SF.',
    );
    const intermediate = intermediateEvents(invocation);
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].content?.parts?.[0].functionCall?.name).toBe(
      'get_weather',
    );
  });

  it('produces one invocation per turn, in order', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{text: 'Hi there!'}], 'inv1'),
      buildEvent('user', [{text: 'How are you?'}], 'inv2'),
      buildEvent('agent', [{text: 'I am fine.'}], 'inv2'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(2);
    expect(invocations[0].userContent.parts?.[0].text).toBe('Hello');
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('Hi there!');
    expect(invocations[1].userContent.parts?.[0].text).toBe('How are you?');
    expect(invocations[1].finalResponse?.parts?.[0].text).toBe('I am fine.');
  });

  it('records every agent that contributed to a turn, in order', () => {
    const events = [
      buildEvent('user', [{text: 'Do something'}], 'inv1'),
      buildEvent('root_agent', [{functionCall: {name: 'tool1'}}], 'inv1'),
      buildEvent('sub_agent_1', [{functionCall: {name: 'tool2'}}], 'inv1'),
      buildEvent(
        'sub_agent_1',
        [{functionCall: {name: 'tool3'}}, {text: 'intermediate response'}],
        'inv1',
      ),
      buildEvent('sub_agent_2', [{functionCall: {name: 'tool4'}}], 'inv1'),
      buildEvent('root_agent', [{text: 'All done.'}], 'inv1'),
    ];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(invocation.finalResponse?.parts?.[0].text).toBe('All done.');
    expect(intermediateEvents(invocation).map((event) => event.author)).toEqual(
      ['root_agent', 'sub_agent_1', 'sub_agent_1', 'sub_agent_2'],
    );
  });

  it('keeps the last final response and demotes the earlier one', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent1', [{text: 'First response'}], 'inv1'),
      buildEvent('agent2', [{text: 'Second response'}], 'inv1'),
    ];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(invocation.finalResponse?.parts?.[0].text).toBe('Second response');
    const intermediate = intermediateEvents(invocation);
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].author).toBe('agent1');
    expect(intermediate[0].content?.parts?.[0].text).toBe('First response');
  });

  it('keeps grounding metadata from the final response', () => {
    const groundingMetadata = {webSearchQueries: ['recent AI news']};
    const events = [
      buildEvent('user', [{text: "What's new in AI?"}], 'inv1'),
      buildEvent('agent', [{text: 'Here are sources.'}], 'inv1', {
        groundingMetadata,
      }),
    ];

    const invocationEvents = intermediateEvents(
      convertEventsToEvalInvocations(events)[0],
    );

    expect(invocationEvents).toHaveLength(1);
    expect(invocationEvents[0].content).toBeUndefined();
    expect(invocationEvents[0]).toMatchObject({groundingMetadata});
  });

  it('records an event that carries only grounding metadata', () => {
    const groundingMetadata = {webSearchQueries: ['sources']};
    const events = [
      buildEvent('user', [{text: 'cite it'}], 'inv1'),
      createEvent({author: 'agent', invocationId: 'inv1', groundingMetadata}),
      buildEvent('agent', [{text: 'Here you go.'}], 'inv1'),
    ];

    const invocationEvents = intermediateEvents(
      convertEventsToEvalInvocations(events)[0],
    );

    expect(invocationEvents).toHaveLength(1);
    expect(invocationEvents[0]).toMatchObject({groundingMetadata});
  });

  it('skips an agent event whose parts carry nothing gradable', () => {
    const events = [
      buildEvent('user', [{text: 'think about it'}], 'inv1'),
      buildEvent('agent', [{thought: true}], 'inv1'),
      buildEvent('agent', [{text: 'Done.'}], 'inv1'),
    ];

    expect(
      intermediateEvents(convertEventsToEvalInvocations(events)[0]),
    ).toHaveLength(0);
  });

  it('treats an author of any case, and a missing author, as the agent', () => {
    const events = [
      buildEvent('USER', [{text: 'Hello'}], 'inv1'),
      createEvent({invocationId: 'inv1', content: {parts: [{text: 'Hi'}]}}),
    ];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(invocation.userContent.parts?.[0].text).toBe('Hello');
    expect(invocation.finalResponse?.parts?.[0].text).toBe('Hi');
  });

  it('records an authorless intermediate event as the agent', () => {
    const events = [
      buildEvent('user', [{text: 'Do something'}], 'inv1'),
      createEvent({
        invocationId: 'inv1',
        content: {parts: [{functionCall: {name: 'tool1'}}]},
      }),
      buildEvent('agent', [{text: 'All done.'}], 'inv1'),
    ];

    const intermediate = intermediateEvents(
      convertEventsToEvalInvocations(events)[0],
    );

    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].author).toBe('agent');
  });

  it('keeps a tool call that skipSummarization marked as final', () => {
    const events = [
      buildEvent('user', [{text: 'run a query'}], 'inv1'),
      buildEvent(
        'agent',
        [
          {
            functionCall: {
              id: 'call_01',
              name: 'execute_sql',
              args: {projectId: 'my-proj', query: 'SELECT 1'},
            },
          },
        ],
        'inv1',
        {actions: {skipSummarization: true}},
      ),
    ];

    const invocation = convertEventsToEvalInvocations(events)[0];

    expect(intermediateEvents(invocation)).toHaveLength(1);
    // A tool call dropped here silently zeroes the tool trajectory score.
    expect(
      getAllToolCalls(invocation.intermediateData).map((call) => call.name),
    ).toEqual(['execute_sql']);
  });

  it('attaches the app details of the matching invocation', () => {
    const events = [buildEvent('user', [{text: 'Hello'}], 'inv1')];
    const appDetails = {agentDetails: {agent: {name: 'agent'}}};

    const invocations = convertEventsToEvalInvocations(events, {
      inv1: appDetails,
    });

    expect(invocations[0].appDetails).toBe(appDetails);
  });
});

describe('collectEventsByInvocationId', () => {
  it('groups events by invocation, keeping first-seen order', () => {
    const events = [
      buildEvent('user', [{text: 'a'}], 'inv2'),
      buildEvent('user', [{text: 'b'}], 'inv1'),
      buildEvent('agent', [{text: 'c'}], 'inv2'),
    ];

    const grouped = collectEventsByInvocationId(events);

    expect([...grouped.keys()]).toEqual(['inv2', 'inv1']);
    expect(grouped.get('inv2')).toHaveLength(2);
    expect(grouped.get('inv1')).toHaveLength(1);
  });
});

describe('toInstructionText', () => {
  it('returns an empty string when there is no instruction', () => {
    expect(toInstructionText()).toBe('');
  });

  it('returns a string instruction as it is', () => {
    expect(toInstructionText('be helpful')).toBe('be helpful');
  });

  it('joins the parts of a Content instruction', () => {
    expect(
      toInstructionText({parts: [{text: 'be helpful'}, {text: 'be brief'}]}),
    ).toBe('be helpful\nbe brief');
  });

  it('joins a list of parts and strings', () => {
    expect(toInstructionText([{text: 'be helpful'}, 'be brief'])).toBe(
      'be helpful\nbe brief',
    );
  });

  it('reads a single part', () => {
    expect(toInstructionText({text: 'be helpful'})).toBe('be helpful');
  });

  it('returns an empty string for a part with no text', () => {
    expect(toInstructionText({})).toBe('');
    expect(toInstructionText({parts: [{}]})).toBe('');
    expect(toInstructionText({role: 'user'})).toBe('');
  });
});

describe('getAppDetailsByInvocationId', () => {
  let intercepter: RequestIntercepterPlugin;

  beforeEach(() => {
    intercepter = new RequestIntercepterPlugin('test_intercepter');
  });

  it('returns nothing for no events', () => {
    expect(getAppDetailsByInvocationId([], intercepter)).toEqual({});
  });

  it('returns an empty entry for an invocation with no model request', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{text: 'Hi there!'}], 'inv1'),
    ];

    expect(getAppDetailsByInvocationId(events, intercepter)).toEqual({
      inv1: {agentDetails: {}},
    });
  });

  it('records the instructions and tools an agent was shown', async () => {
    const tool = {functionDeclarations: [{name: 'tool1'}]};
    const customMetadata = await interceptRequest(intercepter, {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'instruction1', tools: [tool]},
    });
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{text: 'Hi there!'}], 'inv1', {customMetadata}),
    ];

    expect(getAppDetailsByInvocationId(events, intercepter)).toEqual({
      inv1: {
        agentDetails: {
          agent: {
            name: 'agent',
            instructions: 'instruction1',
            toolDeclarations: [tool],
          },
        },
      },
    });
  });

  it('flattens a Content system instruction to text', async () => {
    const customMetadata = await interceptRequest(intercepter, {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: {parts: [{text: 'be helpful'}]}},
    });
    const events = [
      buildEvent('agent', [{text: 'Hi'}], 'inv1', {customMetadata}),
    ];

    expect(
      getAppDetailsByInvocationId(events, intercepter).inv1.agentDetails?.[
        'agent'
      ].instructions,
    ).toBe('be helpful');
  });

  it('keys each invocation separately and keeps the first request per agent', async () => {
    const firstMetadata = await interceptRequest(intercepter, {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'instruction1'},
    });
    const laterMetadata = await interceptRequest(intercepter, {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'instruction2'},
    });
    const events = [
      buildEvent('agent1', [{text: 'first'}], 'inv1', {
        customMetadata: firstMetadata,
      }),
      buildEvent('agent1', [{text: 'second'}], 'inv1', {
        customMetadata: laterMetadata,
      }),
      buildEvent('agent2', [{text: 'other turn'}], 'inv2', {
        customMetadata: laterMetadata,
      }),
    ];

    const appDetails = getAppDetailsByInvocationId(events, intercepter);

    expect(appDetails.inv1.agentDetails).toEqual({
      agent1: {
        name: 'agent1',
        instructions: 'instruction1',
        toolDeclarations: [],
      },
    });
    expect(appDetails.inv2.agentDetails).toEqual({
      agent2: {
        name: 'agent2',
        instructions: 'instruction2',
        toolDeclarations: [],
      },
    });
  });

  it('records an authorless event under the default agent name', async () => {
    const customMetadata = await interceptRequest(intercepter, {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'anonymous'},
    });
    const events = [
      createEvent({
        invocationId: 'inv1',
        content: {parts: [{text: 'Hi'}]},
        customMetadata,
      }),
    ];

    expect(
      getAppDetailsByInvocationId(events, intercepter).inv1.agentDetails,
    ).toEqual({
      agent: {name: 'agent', instructions: 'anonymous', toolDeclarations: []},
    });
  });

  it('skips a callable tool, which carries no declarations', async () => {
    const callableTool = {
      tool: async () => ({}),
      callTool: async () => [],
    };
    const customMetadata = await interceptRequest(intercepter, {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {tools: [callableTool, {functionDeclarations: [{name: 'ok'}]}]},
    });
    const events = [
      buildEvent('agent', [{text: 'Hi'}], 'inv1', {customMetadata}),
    ];

    expect(
      getAppDetailsByInvocationId(events, intercepter).inv1.agentDetails?.[
        'agent'
      ].toolDeclarations,
    ).toEqual([{functionDeclarations: [{name: 'ok'}]}]);
  });
});

describe('buildEvalRunnerConfig', () => {
  const sessionService = new InMemorySessionService();

  it('builds from the bare agent when there is no app', () => {
    const rootAgent = createScriptedAgent('root_agent', ['hi']);
    const intercepter = new RequestIntercepterPlugin(
      'request_intercepter_plugin',
    );

    const config = buildEvalRunnerConfig({
      rootAgent,
      appName: 'my_app',
      internalEvalPlugins: [intercepter],
      sessionService,
    });

    expect(config.app).toBeUndefined();
    expect(config.agent).toBe(rootAgent);
    expect(config.plugins?.map((plugin) => plugin.name)).toEqual([
      'request_intercepter_plugin',
    ]);
  });

  it('merges the eval plugins after the app plugins', () => {
    const rootAgent = createScriptedAgent('root_agent', ['hi']);
    const userPlugin = new SpyPlugin('user_plugin');
    const app = new App({
      name: 'my_app',
      rootAgent,
      plugins: [userPlugin],
    });
    const intercepter = new RequestIntercepterPlugin(
      'request_intercepter_plugin',
    );

    const config = buildEvalRunnerConfig({
      rootAgent,
      appName: 'my_app',
      app,
      internalEvalPlugins: [intercepter],
      sessionService,
    });

    expect(config.agent).toBeUndefined();
    expect(config.plugins).toBeUndefined();
    expect(config.app?.plugins.map((plugin) => plugin.name)).toEqual([
      'user_plugin',
      'request_intercepter_plugin',
    ]);
  });

  it('does not modify the app it was given', () => {
    const rootAgent = createScriptedAgent('root_agent', ['hi']);
    const userPlugin = new SpyPlugin('user_plugin');
    const app = new App({name: 'my_app', rootAgent, plugins: [userPlugin]});
    const originalPlugins = app.plugins;

    for (let run = 0; run < 3; run++) {
      buildEvalRunnerConfig({
        rootAgent,
        appName: 'my_app',
        app,
        internalEvalPlugins: [new SpyPlugin(`eval_plugin_${run}`)],
        sessionService,
      });
    }

    expect(app.plugins).toBe(originalPlugins);
    expect(app.plugins).toEqual([userPlugin]);
  });

  it('points the merged app at the agent under evaluation', () => {
    const fullRoot = createScriptedAgent('full_root', ['hi']);
    const subAgent = createScriptedAgent('sub_agent', ['hi']);
    const app = new App({name: 'my_app', rootAgent: fullRoot});

    const config = buildEvalRunnerConfig({
      rootAgent: subAgent,
      appName: 'my_app',
      app,
      internalEvalPlugins: [],
      sessionService,
    });

    expect(config.app?.rootAgent).toBe(subAgent);
    expect(app.rootAgent).toBe(fullRoot);
  });

  it('names the merged app after the session, not after the app', () => {
    const rootAgent = createScriptedAgent('root_agent', ['hi']);
    const app = new App({name: 'my_app', rootAgent});

    const config = buildEvalRunnerConfig({
      rootAgent,
      appName: 'session_app',
      app,
      internalEvalPlugins: [],
      sessionService,
    });

    expect(config.app?.name).toBe('session_app');
  });
});

describe('generateInferencesForSingleUserInvocation', () => {
  it('emits the user turn once, carrying the runner invocation id', async () => {
    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      appName: 'eval_app',
      agent: createScriptedAgent('agent', ['Agent response']),
      sessionService,
    });
    const session = await sessionService.createSession({
      appName: 'eval_app',
      userId: 'test_user',
    });
    const userContent: Content = {role: 'user', parts: [{text: 'User query'}]};

    const events: Event[] = [];
    for await (const event of generateInferencesForSingleUserInvocation({
      runner,
      userId: 'test_user',
      sessionId: session.id,
      userContent,
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].author).toBe('user');
    expect(events[0].content).toBe(userContent);
    expect(events[0].invocationId).toBe(events[1].invocationId);
    expect(events.filter((event) => event.author === 'user')).toHaveLength(1);

    const reloaded = await sessionService.getSession({
      appName: 'eval_app',
      userId: 'test_user',
      sessionId: session.id,
    });
    expect(reloaded?.events.length).toBeGreaterThan(0);
  });
});

describe('generateInferencesFromRootAgent', () => {
  it('drives the simulator until it stops and converts what it saw', async () => {
    const simulator = new ScriptedUserSimulator(['message 1', 'message 2']);

    const invocations = await generateInferencesFromRootAgent({
      rootAgent: createScriptedAgent('agent', ['reply 1', 'reply 2']),
      userSimulator: simulator,
    });

    expect(simulator.receivedEvents).toHaveLength(3);
    expect(invocations).toHaveLength(2);
    expect(invocations[0].userContent.parts?.[0].text).toBe('message 1');
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('reply 1');
    expect(invocations[1].userContent.parts?.[0].text).toBe('message 2');
    expect(invocations[1].finalResponse?.parts?.[0].text).toBe('reply 2');
  });

  it('populates app details from the intercepted requests', async () => {
    const invocations = await generateInferencesFromRootAgent({
      rootAgent: new LlmAgent({
        name: 'graded_agent',
        model: new ScriptedLlm(['reply']),
        instruction: 'be brief',
      }),
      userSimulator: new ScriptedUserSimulator(['hello']),
    });

    const gradedAgent =
      invocations[0].appDetails?.agentDetails?.['graded_agent'];
    expect(gradedAgent?.name).toBe('graded_agent');
    expect(gradedAgent?.instructions).toContain('be brief');
  });

  it('gives the simulator a deep copy of the conversation so far', async () => {
    const simulator = new ScriptedUserSimulator(
      ['message 1', 'message 2'],
      (events) => {
        const first = events[0];
        if (first?.content?.parts?.[0] !== undefined) {
          first.content.parts[0].text = 'tampered';
        }
        events.push(buildEvent('intruder', [{text: 'injected'}], 'inv-fake'));
      },
    );

    const invocations = await generateInferencesFromRootAgent({
      rootAgent: createScriptedAgent('agent', ['reply 1', 'reply 2']),
      userSimulator: simulator,
    });

    expect(invocations).toHaveLength(2);
    expect(invocations[0].userContent.parts?.[0].text).toBe('message 1');
  });

  it('hands the simulator events that are still branded events', async () => {
    const branded: boolean[] = [];
    const simulator = new ScriptedUserSimulator(['message 1'], (events) => {
      branded.push(...events.map(isEvent));
    });

    await generateInferencesFromRootAgent({
      rootAgent: createScriptedAgent('agent', ['reply 1']),
      userSimulator: simulator,
    });

    expect(branded.length).toBeGreaterThan(0);
    expect(branded.every((isBranded) => isBranded)).toBe(true);
  });

  it('calls resetFunc once, before the run', async () => {
    const calls: number[] = [];
    const simulator = new ScriptedUserSimulator(['hello'], () =>
      calls.push(calls.length),
    );

    await generateInferencesFromRootAgent({
      rootAgent: createScriptedAgent('agent', ['reply']),
      userSimulator: simulator,
      resetFunc: () => calls.push(-1),
    });

    expect(calls[0]).toBe(-1);
    expect(calls.filter((call) => call === -1)).toHaveLength(1);
  });

  it('reuses a pinned session id across runs without colliding', async () => {
    const sessionService = new InMemorySessionService();
    const initialSession = {
      appName: 'test_app',
      userId: 'u',
      sessionId: 'fixed',
    };

    for (let run = 0; run < 2; run++) {
      await generateInferencesFromRootAgent({
        rootAgent: createScriptedAgent('agent', ['reply']),
        userSimulator: new ScriptedUserSimulator([]),
        initialSession,
        sessionService,
      });
    }

    await expect(
      sessionService.getSession({
        appName: 'test_app',
        userId: 'u',
        sessionId: 'fixed',
      }),
    ).resolves.toBeDefined();
  });

  it('keeps the state and events of a session the caller prepared', async () => {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u',
      sessionId: 'fixed',
      state: {preparedBy: 'caller'},
    });
    await sessionService.appendEvent({
      session,
      event: buildEvent('user', [{text: 'earlier turn'}], 'inv0'),
    });

    await generateInferencesFromRootAgent({
      rootAgent: createScriptedAgent('agent', ['reply']),
      userSimulator: new ScriptedUserSimulator([]),
      initialSession: {
        appName: 'test_app',
        userId: 'u',
        sessionId: 'fixed',
        state: {},
      },
      sessionService,
    });

    const reloaded = await sessionService.getSession({
      appName: 'test_app',
      userId: 'u',
      sessionId: 'fixed',
    });
    expect(reloaded?.state['preparedBy']).toBe('caller');
    expect(reloaded?.events.map((e) => e.content?.parts?.[0].text)).toEqual([
      'earlier turn',
    ]);
  });

  it('creates a session under the fallback id when none is pinned', async () => {
    const sessionService = new InMemorySessionService();

    await generateInferencesFromRootAgent({
      rootAgent: createScriptedAgent('agent', ['reply']),
      userSimulator: new ScriptedUserSimulator([]),
      sessionId: 'fallback-id',
      sessionService,
    });

    await expect(
      sessionService.getSession({
        appName: 'EvaluationGenerator',
        userId: 'test_user_id',
        sessionId: 'fallback-id',
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a simulator result whose message and status disagree', async () => {
    const brokenSimulator: UserSimulator = {
      getNextUserMessage: async () => ({
        status: UserSimulatorStatus.SUCCESS,
      }),
    };

    await expect(
      generateInferencesFromRootAgent({
        rootAgent: createScriptedAgent('agent', ['reply']),
        userSimulator: brokenSimulator,
      }),
    ).rejects.toThrow(
      'A user_message should be provided if and only if the status is SUCCESS',
    );
  });

  it('grades a two-turn conversation against the in-memory services', async () => {
    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();
    const memoryService = new InMemoryMemoryService();
    const rootAgent = new LlmAgent({
      name: 'weather_agent',
      model: new ScriptedLlm(['It is sunny.', 'It is 21 degrees.']),
      instruction: 'answer weather questions',
    });

    const invocations = await generateInferencesFromRootAgent({
      rootAgent,
      userSimulator: new ScriptedUserSimulator([
        'what is the weather?',
        'and the temperature?',
      ]),
      initialSession: {appName: 'weather_app', userId: 'u1', state: {}},
      sessionService,
      artifactService,
      memoryService,
    });

    expect(invocations.map((i) => i.userContent.parts?.[0].text)).toEqual([
      'what is the weather?',
      'and the temperature?',
    ]);
    expect(invocations.map((i) => i.finalResponse?.parts?.[0].text)).toEqual([
      'It is sunny.',
      'It is 21 degrees.',
    ]);
    for (const invocation of invocations) {
      expect(
        invocation.appDetails?.agentDetails?.['weather_agent'].instructions,
      ).toContain('answer weather questions');
    }

    const sessions = await sessionService.listSessions({
      appName: 'weather_app',
      userId: 'u1',
    });
    expect(sessions.sessions).toHaveLength(1);
  });

  it('runs the app plugins alongside the eval plugins', async () => {
    const rootAgent = createScriptedAgent('agent', ['reply']);
    const seenRequests: LlmRequest[] = [];
    class RecordingPlugin extends BasePlugin {
      override async beforeModelCallback(params: {
        callbackContext: Context;
        llmRequest: LlmRequest;
      }): Promise<LlmResponse | undefined> {
        seenRequests.push(params.llmRequest);
        return;
      }
    }
    const app = new App({
      name: 'my_app',
      rootAgent,
      plugins: [new RecordingPlugin('recording_plugin')],
    });

    await generateInferencesFromRootAgent({
      rootAgent,
      userSimulator: new ScriptedUserSimulator(['hello']),
      app,
    });

    expect(seenRequests).toHaveLength(1);
    expect(app.plugins.map((plugin) => plugin.name)).toEqual([
      'recording_plugin',
    ]);
  });
});

describe('generateInferencesFromAgentModule', () => {
  it('resolves the root agent through the module app', async () => {
    const invocations = await generateInferencesFromAgentModule({
      modulePath: fixtureModulePath('app_agent.ts'),
      userSimulator: new ScriptedUserSimulator(['hello']),
    });

    expect(invocations[0].finalResponse?.parts?.[0].text).toBe(
      'from the app root agent',
    );
    expect(invocations[0].appDetails?.agentDetails).toHaveProperty(
      'app_root_agent',
    );
  });

  it('resolves the root agent when the module exposes no app', async () => {
    const {resetCalls} = await import('./testdata/root_agent.js');
    resetCalls.length = 0;

    const invocations = await generateInferencesFromAgentModule({
      modulePath: fixtureModulePath('root_agent.ts'),
      userSimulator: new ScriptedUserSimulator(['hello']),
    });

    expect(invocations[0].finalResponse?.parts?.[0].text).toBe(
      'from the root agent',
    );
    expect(resetCalls).toEqual(['reset']);
  });

  it('evaluates the named sub-agent', async () => {
    const invocations = await generateInferencesFromAgentModule({
      modulePath: fixtureModulePath('root_agent.ts'),
      userSimulator: new ScriptedUserSimulator(['hello']),
      agentName: 'fixture_sub_agent',
    });

    expect(invocations[0].finalResponse?.parts?.[0].text).toBe(
      'from the sub agent',
    );
  });

  it('rejects a module that exposes no root agent', async () => {
    const modulePath = fixtureModulePath('no_root_agent.ts');

    await expect(
      generateInferencesFromAgentModule({
        modulePath,
        userSimulator: new ScriptedUserSimulator([]),
      }),
    ).rejects.toThrow(
      `Module '${modulePath}' does not expose agent.rootAgent.`,
    );
  });

  it('rejects a resetData that is not callable', async () => {
    await expect(
      generateInferencesFromAgentModule({
        modulePath: fixtureModulePath('uncallable_reset_agent.ts'),
        userSimulator: new ScriptedUserSimulator([]),
      }),
    ).rejects.toThrow('agent.resetData must be callable when provided.');
  });

  it('rejects a sub-agent name under a workflow root, which holds none', async () => {
    await expect(
      generateInferencesFromAgentModule({
        modulePath: fixtureModulePath('workflow_root_agent.ts'),
        userSimulator: new ScriptedUserSimulator([]),
        agentName: 'workflow_agent',
      }),
    ).rejects.toThrow("Sub-Agent 'workflow_agent' not found.");
  });

  it('rejects a sub-agent name the tree does not hold', async () => {
    await expect(
      generateInferencesFromAgentModule({
        modulePath: fixtureModulePath('root_agent.ts'),
        userSimulator: new ScriptedUserSimulator([]),
        agentName: 'missing_agent',
      }),
    ).rejects.toThrow("Sub-Agent 'missing_agent' not found.");
  });
});

describe('generateResponses', () => {
  function buildEvalSet(evalIds: string[]): EvalSet {
    return {
      evalSetId: 'test_set',
      creationTimestamp: 0,
      evalCases: evalIds.map((evalId) => ({evalId, creationTimestamp: 0})),
    };
  }

  it('repeats each case and builds a fresh simulator per repeat', async () => {
    const created: ScriptedUserSimulator[] = [];
    const gradedCases: EvalCase[] = [];

    const results = await generateResponses({
      evalSet: buildEvalSet(['case_0', 'case_1']),
      agentModulePath: fixtureModulePath('root_agent.ts'),
      repeatNum: 2,
      createUserSimulator: (evalCase) => {
        gradedCases.push(evalCase);
        const simulator = new ScriptedUserSimulator(['hello']);
        created.push(simulator);
        return simulator;
      },
    });

    expect(results.map((result) => result.evalCase.evalId)).toEqual([
      'case_0',
      'case_1',
    ]);
    expect(results[0].responses).toHaveLength(2);
    expect(results[1].responses).toHaveLength(2);
    expect(results[0].responses[0][0].finalResponse?.parts?.[0].text).toBe(
      'from the root agent',
    );
    expect(created).toHaveLength(4);
    expect(new Set(created).size).toBe(4);
    expect(gradedCases.map((evalCase) => evalCase.evalId)).toEqual([
      'case_0',
      'case_0',
      'case_1',
      'case_1',
    ]);
  });

  it('repeats three times when the caller asks for no count', async () => {
    const results = await generateResponses({
      evalSet: buildEvalSet(['case_0']),
      agentModulePath: fixtureModulePath('root_agent.ts'),
      createUserSimulator: () => new ScriptedUserSimulator([]),
    });

    expect(results[0].responses).toHaveLength(3);
  });

  it('runs each case in the session its sessionInput asks for', async () => {
    const {recordedSessions} =
      await import('./testdata/session_recording_agent.js');
    recordedSessions.length = 0;
    const evalSet: EvalSet = {
      evalSetId: 'test_set',
      creationTimestamp: 0,
      evalCases: [
        {
          evalId: 'case_0',
          creationTimestamp: 0,
          sessionInput: {
            appName: 'pinned_app',
            userId: 'pinned_user',
            sessionId: 'pinned_session',
          },
        },
      ],
    };

    await generateResponses({
      evalSet,
      agentModulePath: fixtureModulePath('session_recording_agent.ts'),
      repeatNum: 1,
      createUserSimulator: () => new ScriptedUserSimulator(['hello']),
    });

    expect(recordedSessions).toEqual([
      {
        appName: 'pinned_app',
        userId: 'pinned_user',
        sessionId: 'pinned_session',
      },
    ]);
  });

  it('evaluates the named sub-agent of every case', async () => {
    const results = await generateResponses({
      evalSet: buildEvalSet(['case_0']),
      agentModulePath: fixtureModulePath('root_agent.ts'),
      repeatNum: 1,
      agentName: 'fixture_sub_agent',
      createUserSimulator: () => new ScriptedUserSimulator(['hello']),
    });

    expect(results[0].responses[0][0].finalResponse?.parts?.[0].text).toBe(
      'from the sub agent',
    );
  });
});

describe('processQueryWithSession and generateResponsesFromSession', () => {
  const recordedEvents = (): Event[] => [
    buildEvent('user', [{text: 'Roll a 6 sided dice'}], 'inv1'),
    buildEvent(
      'agent',
      [{functionCall: {name: 'roll_die', args: {sides: 6}}}],
      'inv1',
    ),
    buildEvent('agent', [{text: 'I rolled a 4.'}], 'inv1'),
    buildEvent('user', [{text: 'Thanks'}], 'inv2'),
    buildEvent('agent', [{text: 'You are welcome.'}], 'inv2'),
  ];

  function buildSession(events: Event[]): Session {
    return {
      id: 'recorded_session',
      appName: 'test_app',
      userId: 'test_user',
      state: {},
      events,
      lastUpdateTime: 0,
    };
  }

  async function writeSessionFile(session: Session): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'adk-eval-session-'));
    const sessionPath = path.join(dir, 'session.json');
    await writeFile(sessionPath, JSON.stringify(session), 'utf-8');
    return sessionPath;
  }

  it('annotates each row with the tool calls and text of its invocation', async () => {
    const sessionPath = await writeSessionFile(buildSession(recordedEvents()));
    const evalDataset: EvalRow[][] = [
      [{query: 'Roll a 6 sided dice'}, {query: 'Thanks'}],
    ];

    const results = await generateResponsesFromSession(
      sessionPath,
      evalDataset,
    );

    expect(results).toHaveLength(1);
    const [first, second] = results[0];
    expect(first['actual_tool_use']).toEqual([
      {tool_name: 'roll_die', tool_input: {sides: 6}},
    ]);
    expect(first['response']).toBe('I rolled a 4.');
    expect(second['actual_tool_use']).toEqual([]);
    expect(second['response']).toBe('You are welcome.');
  });

  it('leaves a query the session never saw unanswered', () => {
    const results = processQueryWithSession(buildSession(recordedEvents()), [
      {query: 'Roll a 20 sided dice'},
    ]);

    expect(results[0]['actual_tool_use']).toEqual([]);
    expect(results[0]['response']).toBeUndefined();
  });

  it('does not let another invocation leak into a row', () => {
    const events = [
      buildEvent('user', [{text: 'Roll a 6 sided dice'}], 'inv1'),
      buildEvent('agent', [{text: 'I rolled a 4.'}], 'inv1'),
      buildEvent('user', [{text: 'Book a flight'}], 'inv2'),
      buildEvent(
        'agent',
        [{functionCall: {name: 'book_flight', args: {to: 'LAX'}}}],
        'inv2',
      ),
    ];

    const results = processQueryWithSession(buildSession(events), [
      {query: 'Roll a 6 sided dice'},
    ]);

    expect(results[0]['actual_tool_use']).toEqual([]);
    expect(results[0]['response']).toBe('I rolled a 4.');
  });

  it('skips a recorded event that carries no parts', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      createEvent({author: 'agent', invocationId: 'inv1'}),
      buildEvent('agent', [{text: 'Hi.'}], 'inv1'),
    ];

    const results = processQueryWithSession(buildSession(events), [
      {query: 'Hello'},
    ]);

    expect(results[0]['response']).toBe('Hi.');
  });

  it('does not modify the rows it was given', () => {
    const rows: EvalRow[] = [{query: 'Thanks'}];

    const results = processQueryWithSession(
      buildSession(recordedEvents()),
      rows,
    );

    expect(rows[0]).toEqual({query: 'Thanks'});
    expect(results[0]).not.toBe(rows[0]);
  });

  it('reads a non-ASCII session file as UTF-8', async () => {
    const nonAsciiText = '😀 你好 café';
    const sessionPath = await writeSessionFile(
      buildSession([
        buildEvent('user', [{text: nonAsciiText}], 'inv1'),
        buildEvent('agent', [{text: `response ${nonAsciiText}`}], 'inv1'),
      ]),
    );

    const results = await generateResponsesFromSession(sessionPath, [
      [{query: nonAsciiText}],
    ]);

    expect(results[0][0]['query']).toBe(nonAsciiText);
    expect(results[0][0]['response']).toBe(`response ${nonAsciiText}`);
  });

  it('rejects a row whose query is not a string', () => {
    expect(() =>
      processQueryWithSession(buildSession(recordedEvents()), [{query: 42}]),
    ).toThrow('Each evaluation entry must contain a string query.');
  });
});
