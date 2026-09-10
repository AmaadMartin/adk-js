/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// `test_rebuild_tests_preserves_non_ascii_event_text` is ported from
// google/adk-python tests/unittests/cli/test_agent_test_runner.py (main).

import {
  App,
  createEvent,
  FunctionTool,
  LlmAgent,
  LlmRequest,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  RunnableRoot,
} from '@google/adk';
import {Content, createModelContent, createUserContent} from '@google/genai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {
  buildMockResponses,
  extractUserContent,
  FunctionCallIdMapper,
  getTestFiles,
  MockModel,
  rebuildTests,
  ReplaySessionRunner,
  runAgentReplay,
} from '../../src/cli/agent_test_runner.js';

/** What the stubbed `AgentFile` hands back, set per test. */
const agentHolder = vi.hoisted((): {current?: RunnableRoot} => ({}));
const appHolder = vi.hoisted((): {current?: App} => ({}));

// Only the compile-and-import step is faked; discovery still runs the real
// entry-file lookup.
vi.mock('../../src/utils/agent_loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/agent_loader.js')>()),
  AgentFile: class {
    async load() {
      return appHolder.current ?? agentHolder.current;
    }
    async dispose() {}
  },
}));

const rollDice = new FunctionTool({
  name: 'roll_dice',
  description: 'Rolls a die with the given number of sides.',
  parameters: z.object({sides: z.number()}),
  execute: ({sides}) => ({rolled: sides}),
});

function diceAgent(responses: Content[]): LlmAgent {
  return new LlmAgent({
    name: 'dice_agent',
    model: MockModel.create(responses),
    tools: [rollDice],
  });
}

function emptyRequest(): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}};
}

/** A recorded user turn, the shape a fixture's opening event has. */
function userTurn(text: string): Record<string, unknown> {
  return {author: 'user', content: {role: 'user', parts: [{text}]}};
}

function createAgentDir(
  root: string,
  name: string,
  fixtures: Record<string, unknown> = {},
  entryFileName = 'agent.ts',
): string {
  const agentDir = path.join(root, name);
  fs.mkdirSync(path.join(agentDir, 'tests'), {recursive: true});
  fs.writeFileSync(path.join(agentDir, entryFileName), '');
  for (const [fileName, fixture] of Object.entries(fixtures)) {
    fs.writeFileSync(
      path.join(agentDir, 'tests', fileName),
      JSON.stringify(fixture),
      'utf-8',
    );
  }
  return agentDir;
}

function readFixture(agentDir: string, fileName: string): string {
  return fs.readFileSync(path.join(agentDir, 'tests', fileName), 'utf-8');
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-agent-test-'));
  agentHolder.current = undefined;
  appHolder.current = undefined;
});

afterEach(() => {
  fs.rmSync(workspace, {recursive: true, force: true});
  vi.unstubAllEnvs();
});

describe('getTestFiles', () => {
  it('reads the folder from ADK_TEST_FOLDER', () => {
    createAgentDir(workspace, 'dice_agent', {'basic.json': {events: []}});
    vi.stubEnv('ADK_TEST_FOLDER', workspace);

    expect(getTestFiles().map((testCase) => testCase.id)).toEqual([
      'dice_agent/basic.json',
    ]);
  });

  it('prefers the folder argument over the environment', () => {
    createAgentDir(workspace, 'dice_agent', {'basic.json': {events: []}});
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-agent-other-'));
    vi.stubEnv('ADK_TEST_FOLDER', other);

    try {
      expect(getTestFiles(workspace)).toHaveLength(1);
    } finally {
      fs.rmSync(other, {recursive: true, force: true});
    }
  });

  it('returns nothing when no folder is configured', () => {
    vi.stubEnv('ADK_TEST_FOLDER', '');

    expect(getTestFiles()).toEqual([]);
  });

  it('returns nothing when the folder does not exist', () => {
    expect(getTestFiles(path.join(workspace, 'absent'))).toEqual([]);
  });

  it('finds a fixture in a nested agent directory', () => {
    const nested = path.join(workspace, 'group');
    createAgentDir(nested, 'dice_agent', {'basic.json': {events: []}});

    expect(
      getTestFiles(workspace).map((testCase) => testCase.agentDir),
    ).toEqual([path.join(nested, 'dice_agent')]);
  });

  it.each(['app.js', 'agent.mjs', 'root_agent.yaml'])(
    'accepts %s as the agent entry file',
    (entryFileName) => {
      createAgentDir(
        workspace,
        'dice_agent',
        {'basic.json': {events: []}},
        entryFileName,
      );

      expect(getTestFiles(workspace)).toHaveLength(1);
    },
  );

  it('rejects a tests directory with no agent beside it', () => {
    const testsDir = path.join(workspace, 'not_an_agent', 'tests');
    fs.mkdirSync(testsDir, {recursive: true});
    fs.writeFileSync(path.join(testsDir, 'basic.json'), '{}');

    expect(getTestFiles(workspace)).toEqual([]);
  });

  it('marks a fixture whose stem ends in _xfail', () => {
    createAgentDir(workspace, 'dice_agent', {
      'basic.json': {events: []},
      'broken_xfail.json': {events: []},
    });

    expect(
      getTestFiles(workspace).map((testCase) => [testCase.id, testCase.xfail]),
    ).toEqual([
      ['dice_agent/basic.json', false],
      ['dice_agent/broken_xfail.json', true],
    ]);
  });

  it('reports an id relative to the samples root, with forward slashes', () => {
    const group = path.join(workspace, 'samples', 'group');
    createAgentDir(group, 'dice_agent', {'basic.json': {events: []}});

    expect(getTestFiles(workspace).map((testCase) => testCase.id)).toEqual([
      'group/dice_agent/basic.json',
    ]);
  });
});

describe('MockModel', () => {
  it('builds one response per content and serves them in order', async () => {
    const model = MockModel.create([
      createModelContent('first'),
      createModelContent('second'),
    ]);

    const served: Array<string | undefined> = [];
    for (const request of [emptyRequest(), emptyRequest()]) {
      for await (const response of model.generateContentAsync(request)) {
        served.push(response.content?.parts?.[0]?.text);
      }
    }

    expect(served).toEqual(['first', 'second']);
    expect(model.requests).toHaveLength(2);
  });

  it('reports how many responses it had when they run out', () => {
    const model = MockModel.create([createModelContent('only')]);

    model.nextResponse(emptyRequest());

    expect(() => model.nextResponse(emptyRequest())).toThrow(
      'No more recorded responses available. Requested 2, but only have 1.',
    );
  });

  it('refuses a live connection', async () => {
    await expect(MockModel.create([]).connect()).rejects.toThrow(
      'does not support a live connection',
    );
  });
});

describe('ReplaySessionRunner', () => {
  it('reuses one session across turns', async () => {
    const model = MockModel.create([
      createModelContent('first'),
      createModelContent('second'),
    ]);
    const runner = new ReplaySessionRunner({
      agent: new LlmAgent({name: 'echo_agent', model}),
    });

    await runner.run('hello');
    await runner.run(createUserContent('again'));

    // The second request carries the first turn, which only holds if both
    // turns ran against the same session.
    const secondRequest = model.requests[1];
    expect(JSON.stringify(secondRequest.contents)).toContain('hello');
    expect(JSON.stringify(secondRequest.contents)).toContain('again');
  });
});

describe('extractUserContent', () => {
  it('rebuilds a text turn', () => {
    expect(extractUserContent(userTurn('hello'))).toEqual({
      role: 'user',
      parts: [{text: 'hello'}],
    });
  });

  it('rebuilds function response and function call parts', () => {
    const event = {
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {id: 'fc-1', name: 'roll', response: {rolled: 6}}},
          {functionCall: {id: 'fc-2', name: 'roll', args: {sides: 6}}},
        ],
      },
    };

    expect(extractUserContent(event)).toEqual({
      role: 'user',
      parts: [
        {functionResponse: {id: 'fc-1', name: 'roll', response: {rolled: 6}}},
        {functionCall: {id: 'fc-2', name: 'roll', args: {sides: 6}}},
      ],
    });
  });

  it('rebuilds a function response that records neither an id nor a name', () => {
    expect(
      extractUserContent({
        author: 'user',
        content: {role: 'user', parts: [{functionResponse: {}}]},
      }),
    ).toEqual({
      role: 'user',
      parts: [{functionResponse: {}}],
    });
  });

  it('skips an event another author wrote', () => {
    expect(
      extractUserContent({
        author: 'dice_agent',
        content: {parts: [{text: 'x'}]},
      }),
    ).toBeUndefined();
  });

  it('skips a user-role event a workflow node emitted', () => {
    expect(
      extractUserContent({
        ...userTurn('hello'),
        nodeInfo: {path: 'root/child'},
      }),
    ).toBeUndefined();
  });

  it('skips an event with no replayable part', () => {
    expect(
      extractUserContent({
        author: 'user',
        content: {role: 'user', parts: [{inlineData: {data: 'x'}}]},
      }),
    ).toBeUndefined();
  });

  it('skips an event that is not an object or holds no parts', () => {
    expect(extractUserContent('not an event')).toBeUndefined();
    expect(extractUserContent({author: 'user', content: {}})).toBeUndefined();
  });
});

describe('buildMockResponses', () => {
  it('keeps the model turns and drops the user turns', () => {
    const responses = buildMockResponses([
      {author: 'dice_agent', content: createModelContent('first')},
      {author: 'user', content: createUserContent('next')},
      {author: 'dice_agent', content: createModelContent('second')},
      {author: 'dice_agent'},
    ]);

    expect(
      responses.map((response) => response.content?.parts?.[0]?.text),
    ).toEqual(['first', 'second']);
  });

  it('ignores a turn that is neither a user nor a model turn', () => {
    expect(
      buildMockResponses([
        {author: 'dice_agent', content: {role: 'system', parts: [{text: 'x'}]}},
      ]),
    ).toEqual([]);
  });

  it('drops the model turn ADK synthesizes after set_model_response', () => {
    const responses = buildMockResponses([
      {
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'set_model_response', response: {}}},
          ],
        },
      },
      {author: 'dice_agent', content: createModelContent('synthesized')},
      {author: 'dice_agent', content: createModelContent('from the model')},
    ]);

    expect(
      responses.map((response) => response.content?.parts?.[0]?.text),
    ).toEqual(['from the model']);
  });

  it.each([
    [REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, ''],
    [REQUEST_CREDENTIAL_FUNCTION_CALL_NAME, ''],
    [REQUEST_INPUT_FUNCTION_CALL_NAME, 'root/child'],
  ])('drops the %s request the framework raises', (name, nodePath) => {
    const responses = buildMockResponses([
      {
        author: 'dice_agent',
        nodeInfo: {path: nodePath},
        content: createModelContent({functionCall: {name}}),
      },
    ]);

    expect(responses).toEqual([]);
  });

  it('keeps an input request the root agent made itself', () => {
    const responses = buildMockResponses([
      {
        author: 'dice_agent',
        content: createModelContent({
          functionCall: {name: REQUEST_INPUT_FUNCTION_CALL_NAME},
        }),
      },
    ]);

    expect(responses).toHaveLength(1);
  });
});

describe('runAgentReplay', () => {
  it('skips a fixture with no events', async () => {
    const agentDir = createAgentDir(workspace, 'dice_agent', {
      'basic.json': {events: []},
    });

    const result = await runAgentReplay(
      agentDir,
      path.join(agentDir, 'tests', 'basic.json'),
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: expect.stringContaining('No events in'),
    });
  });

  it('skips a fixture that does not open with a user text turn', async () => {
    const agentDir = createAgentDir(workspace, 'dice_agent', {
      'basic.json': {
        events: [{author: 'dice_agent', content: createModelContent('hi')}],
      },
    });

    const result = await runAgentReplay(
      agentDir,
      path.join(agentDir, 'tests', 'basic.json'),
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: expect.stringContaining('Could not find user message'),
    });
  });

  it('skips a fixture whose opening user turn holds no text', async () => {
    const agentDir = createAgentDir(workspace, 'dice_agent', {
      'basic.json': {events: [userTurn('')]},
    });

    const result = await runAgentReplay(
      agentDir,
      path.join(agentDir, 'tests', 'basic.json'),
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: expect.stringContaining('Could not find user message'),
    });
  });

  it('ignores a recorded entry that is not an event', async () => {
    const agentDir = createAgentDir(
      workspace,
      'dice_agent',
      {'basic.json': {events: [null, userTurn('roll a die')]}},
      'root_agent.yaml',
    );

    const result = await runAgentReplay(
      agentDir,
      path.join(agentDir, 'tests', 'basic.json'),
    );

    // Reading the opening turn off `null` would throw; the replay gets past it
    // and stops on the entry file instead.
    expect(result).toEqual({
      status: 'skipped',
      reason: expect.stringContaining('agent entry file'),
    });
  });

  it('skips a fixture that pins a random number generator', async () => {
    const agentDir = createAgentDir(workspace, 'dice_agent', {
      'basic.json': {
        events: [userTurn('roll a die')],
        mocks: {'random.random': [0.5]},
      },
    });

    const result = await runAgentReplay(
      agentDir,
      path.join(agentDir, 'tests', 'basic.json'),
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: expect.stringContaining('"mocks" block'),
    });
  });

  it('skips an agent directory that only holds a declarative agent', async () => {
    const agentDir = createAgentDir(
      workspace,
      'dice_agent',
      {'basic.json': {events: [userTurn('roll a die')]}},
      'root_agent.yaml',
    );

    const result = await runAgentReplay(
      agentDir,
      path.join(agentDir, 'tests', 'basic.json'),
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: expect.stringContaining('agent entry file'),
    });
  });

  it('replays a fixture a rebuild produced, over two turns and a tool call', async () => {
    const agentDir = createAgentDir(workspace, 'dice_agent', {
      'basic.json': {
        events: [
          userTurn('roll a die'),
          userTurn('roll it again'),
          {lastUpdateTime: 1},
        ],
      },
    });
    const modelTurns = () => [
      createModelContent({functionCall: {name: 'roll_dice', args: {sides: 6}}}),
      createModelContent('You rolled 6.'),
      createModelContent({functionCall: {name: 'roll_dice', args: {sides: 6}}}),
      createModelContent('You rolled 6 again.'),
    ];

    agentHolder.current = diceAgent(modelTurns());
    expect(await rebuildTests(agentDir)).toEqual([
      {testFile: path.join(agentDir, 'tests', 'basic.json'), status: 'rebuilt'},
    ]);

    agentHolder.current = diceAgent([]);
    const result = await runAgentReplay(
      agentDir,
      path.join(agentDir, 'tests', 'basic.json'),
    );

    if (result.status !== 'compared') {
      expect.fail(`expected a comparison, got ${result.reason}`);
    }
    expect(result.actual).toEqual(result.expected);
    expect(JSON.stringify(result.actual)).toContain('You rolled 6 again.');
  });

  it('reports the mismatch when the agent no longer follows the recording', async () => {
    const agentDir = createAgentDir(workspace, 'dice_agent', {
      'basic.json': {
        events: [
          userTurn('say hello'),
          {author: 'dice_agent', content: createModelContent('recorded')},
        ],
      },
    });
    // The plugin answers from the recording, so the drift has to come from the
    // agent renaming itself.
    agentHolder.current = new LlmAgent({
      name: 'renamed_agent',
      model: MockModel.create([]),
    });

    const result = await runAgentReplay(
      agentDir,
      path.join(agentDir, 'tests', 'basic.json'),
    );

    if (result.status !== 'compared') {
      expect.fail(`expected a comparison, got ${result.reason}`);
    }
    expect(result.actual).not.toEqual(result.expected);
  });
});

describe('rebuildTests', () => {
  it('test_rebuild_tests_preserves_non_ascii_event_text', async () => {
    const agentDir = createAgentDir(workspace, 'test_agent', {
      'unicode.json': {
        events: [
          {
            author: 'user',
            content: {role: 'user', parts: [{text: '日本語の質問'}]},
          },
        ],
      },
    });
    agentHolder.current = new LlmAgent({
      name: 'test_agent',
      model: MockModel.create([createModelContent('日本語の回答')]),
    });

    // adk-python scrapes an "Error rebuilding" line off stdout; the port
    // returns the outcome instead.
    expect(await rebuildTests(agentDir)).toEqual([
      {
        testFile: path.join(agentDir, 'tests', 'unicode.json'),
        status: 'rebuilt',
      },
    ]);

    const rebuilt = readFixture(agentDir, 'unicode.json');
    expect(rebuilt).toContain('日本語の質問');
    expect(rebuilt).toContain('日本語の回答');
    expect(rebuilt).not.toContain('\\u');
  });

  it('writes sorted keys, two-space indentation and a trailing newline', async () => {
    const agentDir = createAgentDir(workspace, 'test_agent', {
      'basic.json': {
        lastUpdateTime: 1700000000,
        userId: 'recorded_user',
        events: [userTurn('hello')],
      },
    });
    agentHolder.current = new LlmAgent({
      name: 'test_agent',
      model: MockModel.create([createModelContent('hi')]),
    });

    await rebuildTests(agentDir);

    const rebuilt = readFixture(agentDir, 'basic.json');
    expect(rebuilt.startsWith('{\n  "events": [\n    {\n')).toBe(true);
    expect(rebuilt.endsWith('}\n')).toBe(true);
    // Other recorded keys survive; the update time does not.
    expect(rebuilt).toContain('"userId": "recorded_user"');
    expect(rebuilt).not.toContain('lastUpdateTime');
  });

  it('rebuilds every fixture under a directory', async () => {
    const agentDir = createAgentDir(workspace, 'test_agent', {
      'one.json': {events: [userTurn('one')]},
      'two.json': {events: [userTurn('two')]},
    });
    agentHolder.current = new LlmAgent({
      name: 'test_agent',
      model: MockModel.create([
        createModelContent('a'),
        createModelContent('b'),
      ]),
    });

    const results = await rebuildTests(agentDir);

    expect(results.map((result) => result.status)).toEqual([
      'rebuilt',
      'rebuilt',
    ]);
  });

  it('rebuilds only the fixture a file path names', async () => {
    const agentDir = createAgentDir(workspace, 'test_agent', {
      'one.json': {events: [userTurn('one')]},
      'two.json': {events: [userTurn('two')]},
    });
    agentHolder.current = new LlmAgent({
      name: 'test_agent',
      model: MockModel.create([createModelContent('a')]),
    });

    const results = await rebuildTests(
      path.join(agentDir, 'tests', 'two.json'),
    );

    expect(results).toEqual([
      {testFile: path.join(agentDir, 'tests', 'two.json'), status: 'rebuilt'},
    ]);
    expect(readFixture(agentDir, 'one.json')).not.toContain('\n');
  });

  it('records the failure of one fixture and carries on with the next', async () => {
    const agentDir = createAgentDir(workspace, 'test_agent', {
      'broken.json': {events: [userTurn('one')]},
      'works.json': {events: [userTurn('two')]},
    });
    fs.writeFileSync(
      path.join(agentDir, 'tests', 'broken.json'),
      'not json',
      'utf-8',
    );
    agentHolder.current = new LlmAgent({
      name: 'test_agent',
      model: MockModel.create([createModelContent('a')]),
    });

    const results = await rebuildTests(agentDir);

    expect(results.map((result) => result.status)).toEqual([
      'error',
      'rebuilt',
    ]);
    expect(results[0].reason).toContain('broken.json');
  });

  it('skips a fixture with no events and one with no user turn', async () => {
    const agentDir = createAgentDir(workspace, 'test_agent', {
      'empty.json': {events: []},
      'no_user.json': {
        events: [{author: 'test_agent', content: createModelContent('hi')}],
      },
    });

    const results = await rebuildTests(agentDir);

    expect(results.map((result) => result.status)).toEqual([
      'skipped',
      'skipped',
    ]);
    expect(results[1].reason).toContain('No user messages found');
  });

  it('skips an agent directory that only holds a declarative agent', async () => {
    const agentDir = createAgentDir(
      workspace,
      'test_agent',
      {'basic.json': {events: [userTurn('hello')]}},
      'root_agent.yaml',
    );

    const results = await rebuildTests(agentDir);

    expect(results[0].reason).toContain('agent entry file');
  });

  it('rebuilds an agent the entry file exports as an App', async () => {
    const agentDir = createAgentDir(workspace, 'test_agent', {
      'basic.json': {events: [userTurn('hello')]},
    });
    agentHolder.current = undefined;
    appHolder.current = new App({
      name: 'test_app',
      rootAgent: new LlmAgent({
        name: 'test_agent',
        model: MockModel.create([createModelContent('hi')]),
      }),
    });

    expect((await rebuildTests(agentDir))[0].status).toBe('rebuilt');
    expect(readFixture(agentDir, 'basic.json')).toContain('hi');
  });

  it('skips a fixture whose events are not a list', async () => {
    const agentDir = createAgentDir(workspace, 'test_agent', {
      'basic.json': {events: 'not a list'},
    });

    expect((await rebuildTests(agentDir))[0].status).toBe('skipped');
  });

  it('returns nothing when the folder holds no fixture', async () => {
    expect(await rebuildTests(workspace)).toEqual([]);
  });
});

describe('FunctionCallIdMapper', () => {
  it('answers a recorded response with the id the live call was given', () => {
    const mapper = new FunctionCallIdMapper(['recorded-1']);
    mapper.absorb([
      createEvent({
        author: 'dice_agent',
        content: createModelContent({
          functionCall: {id: 'live-1', name: 'roll_dice'},
        }),
      }),
    ]);
    const content: Content = {
      role: 'user',
      parts: [
        {functionResponse: {id: 'recorded-1', name: 'roll_dice'}},
        {functionResponse: {id: 'unknown', name: 'roll_dice'}},
        {text: 'no response here'},
      ],
    };

    mapper.remap(content);

    expect(content.parts?.map((part) => part.functionResponse?.id)).toEqual([
      'live-1',
      'unknown',
      undefined,
    ]);
  });

  it('stops pairing once the recorded ids run out', () => {
    const mapper = new FunctionCallIdMapper([]);
    mapper.absorb([
      createEvent({
        author: 'dice_agent',
        content: createModelContent({
          functionCall: {id: 'live-1', name: 'roll_dice'},
        }),
      }),
    ]);
    const content: Content = {
      role: 'user',
      parts: [{functionResponse: {id: 'recorded-1'}}],
    };

    mapper.remap(content);

    expect(content.parts?.[0]?.functionResponse?.id).toBe('recorded-1');
  });
});
