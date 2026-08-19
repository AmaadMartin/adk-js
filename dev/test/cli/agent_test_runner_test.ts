/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmResponse} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {JsonObject} from '../../src/cli/agent_test_normalization.js';
import {
  getTestFiles,
  rebuildAgentTests,
  runAgentTests,
} from '../../src/cli/agent_test_runner.js';
import {RecordedModelPlugin} from '../../src/cli/recorded_model_plugin.js';

/**
 * The agent files below are imported by Node, not by Vitest, so they resolve
 * `@google/adk` through a `node_modules` symlink to this repository's.
 */
const REPO_NODE_MODULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../node_modules',
);

/** Load the agent file directly: the esbuild pass has its own tests. */
const UNCOMPILED = {compile: false, bundle: false};

/** Test budget (ms) for the one case that bundles the agent with esbuild. */
const BUNDLED_LOAD_TIMEOUT_MS = 60000;

/**
 * An agent whose model throws. A replay that passes against it proves the
 * recorded responses answered every model call.
 */
const REPLAY_AGENT_SOURCE = `
import {BaseLlm, FunctionTool, LlmAgent} from '@google/adk';

class UnreachableModel extends BaseLlm {
  constructor() {
    super({model: 'unreachable'});
  }
  connect() {
    throw new Error('the replayed agent opened a live model connection');
  }
  async *generateContentAsync() {
    throw new Error('the replayed agent called the real model');
  }
}

export const rootAgent = new LlmAgent({
  name: 'dice_agent',
  model: new UnreachableModel(),
  instruction: 'Roll dice when asked.',
  tools: [
    new FunctionTool({
      name: 'roll_dice',
      description: 'Rolls a die.',
      execute: () => 4,
    }),
  ],
});
`;

/** An agent with a scripted model, so that a rebuild is reproducible. */
const REBUILD_AGENT_SOURCE = `
import {BaseLlm, LlmAgent} from '@google/adk';

class ScriptedModel extends BaseLlm {
  constructor() {
    super({model: 'scripted'});
  }
  connect() {
    throw new Error('the rebuilt agent opened a live model connection');
  }
  async *generateContentAsync() {
    yield {content: {role: 'model', parts: [{text: 'Scripted reply.'}]}};
  }
}

export const rootAgent = new LlmAgent({
  name: 'scripted_agent',
  model: new ScriptedModel(),
  instruction: 'Reply.',
});
`;

/**
 * A two-turn conversation with the `dice_agent`: a tool call, its result, and
 * a follow-up turn.
 */
const DICE_FIXTURE: JsonObject = {
  events: [
    userEvent('roll a die'),
    {
      author: 'dice_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc-1', name: 'roll_dice', args: {}}}],
      },
    },
    {
      author: 'dice_agent',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'roll_dice',
              response: {result: 4},
            },
          },
        ],
      },
    },
    {
      author: 'dice_agent',
      content: {role: 'model', parts: [{text: 'You rolled 4.'}]},
    },
    userEvent('roll again'),
    {
      author: 'dice_agent',
      content: {role: 'model', parts: [{text: 'Once is enough.'}]},
    },
  ],
};

function userEvent(text: string): JsonObject {
  return {author: 'user', content: {role: 'user', parts: [{text}]}};
}

let tempDir: string;
let logLines: string[];

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-agent-test-'));
  logLines = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logLines.push(line);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempDir, {recursive: true, force: true});
});

/** Writes an agent directory, with its fixtures, under `tempDir`. */
async function writeAgent(
  agentDirName: string,
  source: string,
  fixtures: Record<string, JsonObject> = {},
): Promise<string> {
  const agentDir = path.join(tempDir, agentDirName);
  await fs.mkdir(path.join(agentDir, 'tests'), {recursive: true});
  await fs.writeFile(path.join(agentDir, 'agent.js'), source);
  await fs.symlink(
    REPO_NODE_MODULES,
    path.join(agentDir, 'node_modules'),
    'dir',
  );
  for (const [fileName, fixture] of Object.entries(fixtures)) {
    await fs.writeFile(
      path.join(agentDir, 'tests', fileName),
      JSON.stringify(fixture, null, 2),
    );
  }
  return agentDir;
}

async function writeFixtureOnlyDir(
  relativeDir: string,
  fileName: string,
  contents: string,
): Promise<void> {
  const testsDir = path.join(tempDir, relativeDir, 'tests');
  await fs.mkdir(testsDir, {recursive: true});
  await fs.writeFile(path.join(testsDir, fileName), contents);
}

function withMutatedToolResult(result: number): JsonObject {
  const mutated = JSON.parse(JSON.stringify(DICE_FIXTURE)) as JsonObject;
  const events = mutated['events'] as JsonObject[];
  const content = events[2]['content'] as JsonObject;
  const parts = content['parts'] as JsonObject[];
  (parts[0]['functionResponse'] as JsonObject)['response'] = {result};
  return mutated;
}

describe('getTestFiles', () => {
  it('finds fixtures at more than one level of nesting', async () => {
    await writeAgent('top', REPLAY_AGENT_SOURCE, {'a.json': DICE_FIXTURE});
    await writeAgent(
      path.join('nested', 'deeper', 'inner'),
      REPLAY_AGENT_SOURCE,
      {
        'b.json': DICE_FIXTURE,
      },
    );

    const testCases = await getTestFiles(tempDir);

    expect(testCases.map((testCase) => testCase.name)).toEqual([
      'inner/b.json',
      'top/a.json',
    ]);
  });

  it('pairs a fixture with its agent directory and entry file', async () => {
    const agentDir = await writeAgent('top', REPLAY_AGENT_SOURCE, {
      'a.json': DICE_FIXTURE,
    });

    const [testCase] = await getTestFiles(tempDir);

    expect(testCase.agentDir).toBe(agentDir);
    expect(testCase.entryFile).toBe(path.join(agentDir, 'agent.js'));
    expect(testCase.testFile).toBe(path.join(agentDir, 'tests', 'a.json'));
    expect(testCase.name).toBe('top/a.json');
  });

  it('ignores a tests directory whose parent holds no agent entry file', async () => {
    await writeFixtureOnlyDir('not_an_agent', 'a.json', '{"events": []}');

    expect(await getTestFiles(tempDir)).toEqual([]);
  });

  it('ignores a non-json file in a tests directory', async () => {
    await writeAgent('top', REPLAY_AGENT_SOURCE);
    await fs.writeFile(path.join(tempDir, 'top', 'tests', 'notes.md'), 'hello');

    expect(await getTestFiles(tempDir)).toEqual([]);
  });

  it('skips node_modules and dot-directories', async () => {
    await writeAgent(
      path.join('node_modules', 'vendored'),
      REPLAY_AGENT_SOURCE,
      {
        'a.json': DICE_FIXTURE,
      },
    );
    await writeAgent(path.join('.cache', 'hidden'), REPLAY_AGENT_SOURCE, {
      'b.json': DICE_FIXTURE,
    });

    expect(await getTestFiles(tempDir)).toEqual([]);
  });

  it('marks an _xfail fixture as an expected failure', async () => {
    await writeAgent('top', REPLAY_AGENT_SOURCE, {
      'ordinary.json': DICE_FIXTURE,
      'broken_xfail.json': DICE_FIXTURE,
    });

    const testCases = await getTestFiles(tempDir);

    expect(
      testCases.map((testCase) => [testCase.name, testCase.expectedFailure]),
    ).toEqual([
      ['top/broken_xfail.json', true],
      ['top/ordinary.json', false],
    ]);
  });

  it('returns nothing for a folder that does not exist', async () => {
    expect(await getTestFiles(path.join(tempDir, 'absent'))).toEqual([]);
  });
});

describe('RecordedModelPlugin', () => {
  const responses: LlmResponse[] = [
    {content: {role: 'model', parts: [{text: 'first'}]}},
    {content: {role: 'model', parts: [{text: 'second'}]}},
  ];

  it('returns the recorded responses in order', async () => {
    const plugin = new RecordedModelPlugin(responses, 'top/a.json');

    expect(await callPlugin(plugin)).toBe(responses[0]);
    expect(await callPlugin(plugin)).toBe(responses[1]);
  });

  it('throws a message naming the fixture once the responses run out', async () => {
    const plugin = new RecordedModelPlugin(responses.slice(0, 1), 'top/a.json');
    await callPlugin(plugin);

    await expect(callPlugin(plugin)).rejects.toThrow(
      'top/a.json: the agent asked the model for response 2 but only 1 were recorded.',
    );
  });

  /**
   * The callback only reads its own counter, so the request and context it is
   * handed never matter; an empty parameter object keeps that explicit.
   */
  function callPlugin(
    plugin: RecordedModelPlugin,
  ): Promise<LlmResponse | undefined> {
    return plugin.beforeModelCallback(
      {} as Parameters<RecordedModelPlugin['beforeModelCallback']>[0],
    );
  }
});

describe('runAgentTests', () => {
  it('passes when the agent reproduces the recorded conversation', async () => {
    await writeAgent('dice', REPLAY_AGENT_SOURCE, {'roll.json': DICE_FIXTURE});

    const results = await runAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(results).toEqual([{name: 'dice/roll.json', status: 'passed'}]);
    expect(logLines).toContain('PASSED dice/roll.json');
    expect(logLines).toContain(
      '1 passed, 0 failed, 0 skipped, 0 xfail, 0 xpass',
    );
  });

  it(
    'passes with the compiled and bundled agent the CLI loads by default',
    async () => {
      // The bundled agent carries its own copy of @google/adk, which is the
      // configuration `adk test` actually ships with.
      await writeAgent('dice', REPLAY_AGENT_SOURCE, {
        'roll.json': DICE_FIXTURE,
      });

      const results = await runAgentTests({folder: tempDir});

      expect(results).toEqual([{name: 'dice/roll.json', status: 'passed'}]);
    },
    BUNDLED_LOAD_TIMEOUT_MS,
  );

  it('fails and names the fixture when a recorded tool result changed', async () => {
    await writeAgent('dice', REPLAY_AGENT_SOURCE, {
      'roll.json': withMutatedToolResult(99),
    });

    const [result] = await runAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toContain('dice/roll.json');
    expect(result.message).toContain('99');
  });

  it('reports an expected failure as xfail and an unexpected pass as xpass', async () => {
    await writeAgent('dice', REPLAY_AGENT_SOURCE, {
      'broken_xfail.json': withMutatedToolResult(99),
      'works_xfail.json': DICE_FIXTURE,
    });

    const results = await runAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(results.map((result) => [result.name, result.status])).toEqual([
      ['dice/broken_xfail.json', 'xfail'],
      ['dice/works_xfail.json', 'xpass'],
    ]);
  });

  it('fails the fixture when the agent asks for an unrecorded response', async () => {
    const truncated = JSON.parse(JSON.stringify(DICE_FIXTURE)) as JsonObject;
    truncated['events'] = (truncated['events'] as JsonObject[]).slice(0, 2);
    await writeAgent('dice', REPLAY_AGENT_SOURCE, {'roll.json': truncated});

    const [result] = await runAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toContain(
      'the agent asked the model for response 2 but only 1 were recorded.',
    );
  });

  it('fails the fixture when the agent file cannot be loaded', async () => {
    await writeAgent('broken', 'throw new Error("boom while loading");', {
      'a.json': DICE_FIXTURE,
    });

    const [result] = await runAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toContain('broken/a.json');
    expect(result.message).toContain('boom while loading');
  });

  it('skips a fixture with no events, with mocks, or with no opening message', async () => {
    await writeAgent('dice', REPLAY_AGENT_SOURCE, {
      'empty.json': {events: []},
      'mocked.json': {...DICE_FIXTURE, mocks: {'random.random': [0.5]}},
      'no_user.json': {
        events: [
          {
            author: 'dice_agent',
            content: {role: 'model', parts: [{text: 'hi'}]},
          },
        ],
      },
    });

    const results = await runAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(results).toEqual([
      {
        name: 'dice/empty.json',
        status: 'skipped',
        message: 'the fixture records no events',
      },
      {
        name: 'dice/mocked.json',
        status: 'skipped',
        message:
          'the fixture relies on recorded RNG mocks, which are not supported',
      },
      {
        name: 'dice/no_user.json',
        status: 'skipped',
        message: 'the fixture does not open with a user text message',
      },
    ]);
  });

  it('reports an empty folder without failing', async () => {
    const results = await runAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(results).toEqual([]);
    expect(logLines).toEqual([`No agent test files found in ${tempDir}`]);
  });
});

describe('rebuildAgentTests', () => {
  it('rewrites a fixture, and a second rebuild changes no byte', async () => {
    await writeAgent('scripted', REBUILD_AGENT_SOURCE, {
      'chat.json': {
        appName: 'scripted',
        lastUpdateTime: 12345,
        events: [userEvent('hello')],
      },
    });
    const fixturePath = path.join(tempDir, 'scripted', 'tests', 'chat.json');

    await rebuildAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });
    const first = await fs.readFile(fixturePath, 'utf-8');

    await rebuildAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });
    expect(await fs.readFile(fixturePath, 'utf-8')).toBe(first);

    const rebuilt = JSON.parse(first) as JsonObject;
    // Unrecognised session keys survive; the volatile timestamp does not.
    expect(rebuilt['appName']).toBe('scripted');
    expect(rebuilt).not.toHaveProperty('lastUpdateTime');
    expect(rebuilt['events']).toEqual([
      {
        author: 'user',
        id: 'e-1',
        invocationId: 'i-1',
        longRunningToolIds: [],
        content: {role: 'user', parts: [{text: 'hello'}]},
      },
      {
        author: 'scripted_agent',
        id: 'e-2',
        invocationId: 'i-1',
        longRunningToolIds: [],
        content: {role: 'model', parts: [{text: 'Scripted reply.'}]},
      },
    ]);
    expect(first.endsWith('\n')).toBe(true);
  });

  it('reports a failing fixture and continues with the next one', async () => {
    await writeAgent('broken', 'throw new Error("boom while loading");', {
      'a.json': {events: [userEvent('hello')]},
    });
    await writeAgent('scripted', REBUILD_AGENT_SOURCE, {
      'b.json': {events: [userEvent('hello')]},
    });

    await rebuildAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(logLines[0]).toContain('FAILED broken/a.json');
    expect(logLines[0]).toContain('boom while loading');
    expect(logLines[1]).toContain('REBUILT');
    expect(logLines[1]).toContain('b.json');
  });

  it('skips a fixture with no user messages', async () => {
    await writeAgent('scripted', REBUILD_AGENT_SOURCE, {
      'a.json': {
        events: [
          {
            author: 'user',
            nodeInfo: {path: 'wf.node'},
            content: {role: 'user', parts: [{text: 'agent emitted'}]},
          },
        ],
      },
    });

    await rebuildAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(logLines).toEqual([
      'SKIPPED scripted/a.json: the fixture records no user messages',
    ]);
  });

  it('reports an empty folder without failing', async () => {
    await rebuildAgentTests({
      folder: tempDir,
      agentFileLoadOptions: UNCOMPILED,
    });

    expect(logLines).toEqual([`No agent test files found in ${tempDir}`]);
  });
});
