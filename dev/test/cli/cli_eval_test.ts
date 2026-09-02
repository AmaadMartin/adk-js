/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  createGcsEvalManagersFromUri,
  DEFAULT_EVAL_CONFIG,
  EvalSet,
  InMemoryEvalSetsManager,
  LlmAgent,
  MISSING_EVAL_DEPENDENCIES_MESSAGE,
  setEvalRuntime,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  parseAndGetEvalsToRun,
  resolveEvalAppLocation,
  resolveEvalConfigFilePath,
  runEvalCli,
} from '../../src/cli/cli_eval.js';
import {StubEvalRuntime} from './stub_eval_runtime.js';

/** What the mocked AgentFile loads, and whether the command disposed it. */
const agentFile = vi.hoisted(() => ({load: vi.fn(), disposals: 0}));

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentFile: vi.fn(() => ({
    load: agentFile.load,
    [Symbol.asyncDispose]: async () => {
      agentFile.disposals++;
    },
  })),
}));

// Only the GCS factory is faked; every other export is the real one, so the
// eval sets and the results go through the real local managers.
vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...actual,
    createGcsEvalManagersFromUri: vi.fn(actual.createGcsEvalManagersFromUri),
  };
});

const APP_NAME = 'home_automation';
const EVAL_SET_ID = 'smoke';

/** An eval set as it is written next to an agent, in snake_case. */
const ON_DISK_EVAL_SET = {
  eval_set_id: EVAL_SET_ID,
  creation_timestamp: 12.5,
  eval_cases: [
    {
      eval_id: 'lights_on',
      creation_timestamp: 12.5,
      conversation: [
        {
          invocation_id: 'inv-1',
          user_content: {role: 'user', parts: [{text: 'Lights on'}]},
          final_response: {role: 'model', parts: [{text: 'Done.'}]},
        },
      ],
    },
    {
      eval_id: 'lights_off',
      creation_timestamp: 12.5,
      conversation: [
        {
          invocation_id: 'inv-2',
          user_content: {role: 'user', parts: [{text: 'Lights off'}]},
          final_response: {role: 'model', parts: [{text: 'Done.'}]},
        },
      ],
    },
  ],
};

let agentsDir: string;
let agentPath: string;
let runtime: StubEvalRuntime;
let printed: string[];

/** Writes a file under the app directory and returns its path. */
async function writeAppFile(name: string, contents: unknown): Promise<string> {
  const filePath = path.join(agentsDir, APP_NAME, name);
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, JSON.stringify(contents), 'utf-8');
  return filePath;
}

async function listEvalHistory(): Promise<string[]> {
  return fs.readdir(path.join(agentsDir, APP_NAME, '.adk', 'eval_history'));
}

beforeEach(async () => {
  agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-cli-eval-'));
  agentPath = path.join(agentsDir, APP_NAME, 'agent.ts');
  runtime = new StubEvalRuntime();
  setEvalRuntime(runtime);

  agentFile.disposals = 0;
  agentFile.load
    .mockReset()
    .mockResolvedValue(new LlmAgent({name: 'root', model: 'gemini-2.0-flash'}));

  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  setEvalRuntime(undefined);
  vi.restoreAllMocks();
  vi.mocked(createGcsEvalManagersFromUri).mockReset();
  await fs.rm(agentsDir, {recursive: true, force: true});
});

describe('parseAndGetEvalsToRun', () => {
  it('runs every eval case of an entry with no selector', () => {
    expect([...parseAndGetEvalsToRun(['my_set'])]).toEqual([['my_set', []]]);
  });

  it('reads the eval cases out of the selector', () => {
    expect([...parseAndGetEvalsToRun(['my_set:case1,case2'])]).toEqual([
      ['my_set', ['case1', 'case2']],
    ]);
  });

  it('accumulates the eval cases of a repeated eval set', () => {
    expect([
      ...parseAndGetEvalsToRun(['my_set:case1', 'my_set:case2']),
    ]).toEqual([['my_set', ['case1', 'case2']]]);
  });

  it('drops the empty entries of a selector', () => {
    expect([...parseAndGetEvalsToRun(['my_set:case1,,  ,case2'])]).toEqual([
      ['my_set', ['case1', 'case2']],
    ]);
  });

  it('keeps a Windows drive letter out of the selector', () => {
    expect([...parseAndGetEvalsToRun(['C:\\evals\\my.json'])]).toEqual([
      ['C:\\evals\\my.json', []],
    ]);
    expect([...parseAndGetEvalsToRun(['C:/evals/my.json'])]).toEqual([
      ['C:/evals/my.json', []],
    ]);
  });

  it('reads a selector after a Windows drive letter', () => {
    expect([...parseAndGetEvalsToRun(['C:\\evals\\my.json:case1'])]).toEqual([
      ['C:\\evals\\my.json', ['case1']],
    ]);
  });
});

describe('resolveEvalConfigFilePath', () => {
  it('uses the path the caller gave', () => {
    expect(
      resolveEvalConfigFilePath('/tmp/explicit.json', '/tmp/my.evalset.json'),
    ).toBe('/tmp/explicit.json');
  });

  it('reads the config next to the one eval set file', () => {
    expect(
      resolveEvalConfigFilePath(
        undefined,
        path.join('evals', 'my.evalset.json'),
      ),
    ).toBe(path.join('evals', 'test_config.json'));
  });

  it('uses the defaults when the run reads no single eval set file', () => {
    expect(resolveEvalConfigFilePath(undefined, undefined)).toBeUndefined();
  });
});

describe('resolveEvalAppLocation', () => {
  it('names the app after the directory of an agent.ts', () => {
    expect(
      resolveEvalAppLocation(path.join('a', 'b', 'my_agent', 'agent.ts')),
    ).toEqual({
      appName: 'my_agent',
      agentsDir: path.resolve('a', 'b'),
    });
  });

  it('names the app after a single-file agent', () => {
    expect(resolveEvalAppLocation(path.join('a', 'b', 'my_agent.ts'))).toEqual({
      appName: 'my_agent',
      agentsDir: path.resolve('a', 'b'),
    });
  });
});

describe('runEvalCli', () => {
  it('reports the missing eval runtime before it loads the agent', async () => {
    setEvalRuntime(undefined);

    await expect(
      runEvalCli({
        agentPath,
        evalSetFileOrIds: [EVAL_SET_ID],
        printDetailedResults: false,
      }),
    ).rejects.toThrowError(MISSING_EVAL_DEPENDENCIES_MESSAGE);
    expect(agentFile.load).not.toHaveBeenCalled();
  });

  it('runs an eval set file and writes the result to the eval history', async () => {
    const evalSetFile = await writeAppFile(
      `${EVAL_SET_ID}.evalset.json`,
      ON_DISK_EVAL_SET,
    );

    await runEvalCli({
      agentPath,
      evalSetFileOrIds: [evalSetFile],
      printDetailedResults: false,
    });

    // The eval set is named by the file's own `eval_set_id`, not by its path.
    expect(runtime.service?.inferenceRequests).toEqual([
      {
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        evalCaseIds: undefined,
        inferenceConfig: {useLive: false},
      },
    ]);
    const history = await listEvalHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toContain(APP_NAME);
    expect(agentFile.disposals).toBe(1);
    expect(printed).toContain('Eval Run Summary');
    expect(printed).toContain(
      `${EVAL_SET_ID}:\n  Tests passed: 1\n  Tests failed: 1`,
    );
  });

  it('reads the config next to a single eval set file', async () => {
    const evalSetFile = await writeAppFile(
      `${EVAL_SET_ID}.evalset.json`,
      ON_DISK_EVAL_SET,
    );
    await writeAppFile('test_config.json', {
      criteria: {response_match_score: 0.42},
    });

    await runEvalCli({
      agentPath,
      evalSetFileOrIds: [evalSetFile],
      printDetailedResults: false,
    });

    expect(runtime.params?.evalConfig.criteria).toEqual({
      response_match_score: 0.42,
    });
  });

  it('uses the default criteria for an eval set id', async () => {
    await writeAppFile(`${EVAL_SET_ID}.evalset.json`, ON_DISK_EVAL_SET);
    await writeAppFile('test_config.json', {
      criteria: {response_match_score: 0.42},
    });

    await runEvalCli({
      agentPath,
      evalSetFileOrIds: [EVAL_SET_ID],
      printDetailedResults: false,
    });

    expect(runtime.params?.evalConfig).toEqual(DEFAULT_EVAL_CONFIG);
  });

  it('uses the default criteria for two eval set files', async () => {
    const first = await writeAppFile('a.evalset.json', {
      ...ON_DISK_EVAL_SET,
      eval_set_id: 'a',
    });
    const second = await writeAppFile('b.evalset.json', {
      ...ON_DISK_EVAL_SET,
      eval_set_id: 'b',
    });
    await writeAppFile('test_config.json', {
      criteria: {response_match_score: 0.42},
    });

    await runEvalCli({
      agentPath,
      evalSetFileOrIds: [first, second],
      printDetailedResults: false,
    });

    expect(runtime.params?.evalConfig).toEqual(DEFAULT_EVAL_CONFIG);
  });

  it('runs an eval set id through the local eval sets manager', async () => {
    await writeAppFile(`${EVAL_SET_ID}.evalset.json`, ON_DISK_EVAL_SET);

    await runEvalCli({
      agentPath,
      evalSetFileOrIds: [`${EVAL_SET_ID}:lights_on`],
      printDetailedResults: false,
    });

    expect(runtime.service?.inferenceRequests[0].evalCaseIds).toEqual([
      'lights_on',
    ]);
    expect(printed).toContain(
      `${EVAL_SET_ID}:\n  Tests passed: 1\n  Tests failed: 0`,
    );
    expect(await listEvalHistory()).toHaveLength(1);
  });

  it('prints the per-case detail only when asked', async () => {
    await writeAppFile(`${EVAL_SET_ID}.evalset.json`, ON_DISK_EVAL_SET);
    const options = {
      agentPath,
      evalSetFileOrIds: [EVAL_SET_ID],
      printDetailedResults: false,
    };

    await runEvalCli(options);
    expect(printed.join('\n')).not.toContain('Eval Set Id:');

    printed = [];
    await runEvalCli({...options, printDetailedResults: true});
    const output = printed.join('\n');
    expect(output).toContain(`Eval Set Id: ${EVAL_SET_ID}`);
    expect(output).toContain('Eval Id: lights_on');
    expect(output).toContain('Overall Eval Status: PASSED');
    expect(output).toContain(
      'Metric: response_match_score, Status: PASSED, Score: 1, Threshold: 0.8',
    );
    expect(output).toContain('Invocation Details:');
  });

  it('runs live when the eval config asks for it', async () => {
    await writeAppFile(`${EVAL_SET_ID}.evalset.json`, ON_DISK_EVAL_SET);
    const configFilePath = await writeAppFile('live_config.json', {
      criteria: {response_match_score: 0.8},
      live_model_config: {timeout_seconds: 42},
    });

    await runEvalCli({
      agentPath,
      evalSetFileOrIds: [EVAL_SET_ID],
      configFilePath,
      printDetailedResults: false,
    });

    expect(runtime.service?.inferenceRequests[0].inferenceConfig).toEqual({
      useLive: true,
      liveTimeoutSeconds: 42,
    });
  });

  it('reads and writes through the managers a gs:// URI builds', async () => {
    const evalSetsManager = new InMemoryEvalSetsManager();
    await evalSetsManager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await evalSetsManager.addEvalCase(APP_NAME, EVAL_SET_ID, {
      evalId: 'lights_on',
      conversation: [],
      creationTimestamp: 1,
    });
    const saved: EvalSet[] = [];
    vi.mocked(createGcsEvalManagersFromUri).mockReturnValue({
      evalSetsManager,
      evalSetResultsManager: {
        saveEvalSetResult: async (appName, evalSetId) => {
          saved.push({evalSetId, evalCases: [], creationTimestamp: 0});
          expect(appName).toBe(APP_NAME);
        },
        getEvalSetResult: async () => {
          throw new Error('not used');
        },
        listEvalSetResults: async () => [],
      },
    });

    await runEvalCli({
      agentPath,
      evalSetFileOrIds: [EVAL_SET_ID],
      evalStorageUri: 'gs://my-bucket',
      printDetailedResults: false,
    });

    expect(createGcsEvalManagersFromUri).toHaveBeenCalledWith('gs://my-bucket');
    expect(saved.map((result) => result.evalSetId)).toEqual([EVAL_SET_ID]);
    // Nothing was written next to the agent.
    await expect(listEvalHistory()).rejects.toThrow();
  });

  it('refuses a storage URI of any other scheme', async () => {
    await expect(
      runEvalCli({
        agentPath,
        evalSetFileOrIds: [EVAL_SET_ID],
        evalStorageUri: 'file:///tmp/evals',
        printDetailedResults: false,
      }),
    ).rejects.toThrowError(
      'Unsupported evals storage URI: file:///tmp/evals. Supported URIs: ' +
        'gs://<bucket name>',
    );
  });

  it('reports an eval set file that is not there', async () => {
    const present = await writeAppFile(
      `${EVAL_SET_ID}.evalset.json`,
      ON_DISK_EVAL_SET,
    );
    const missing = path.join(agentsDir, APP_NAME, 'absent.evalset.json');

    await expect(
      runEvalCli({
        agentPath,
        evalSetFileOrIds: [present, missing],
        printDetailedResults: false,
      }),
    ).rejects.toThrowError(`\`${missing}\` should be a valid eval set file.`);
  });

  it('passes the app on to the eval service when the module exports one', async () => {
    await writeAppFile(`${EVAL_SET_ID}.evalset.json`, ON_DISK_EVAL_SET);
    const app = new App({
      name: APP_NAME,
      rootAgent: new LlmAgent({name: 'root', model: 'gemini-2.0-flash'}),
    });
    agentFile.load.mockResolvedValue(app);

    await runEvalCli({
      agentPath,
      evalSetFileOrIds: [EVAL_SET_ID],
      printDetailedResults: false,
    });

    expect(runtime.params?.app).toBe(app);
    expect(runtime.params?.rootAgent).toBe(app.rootAgent);
  });

  it('reports an agent module that exports no agent', async () => {
    await writeAppFile(`${EVAL_SET_ID}.evalset.json`, ON_DISK_EVAL_SET);
    agentFile.load.mockResolvedValue({notAnAgent: true});

    await expect(
      runEvalCli({
        agentPath,
        evalSetFileOrIds: [EVAL_SET_ID],
        printDetailedResults: false,
      }),
    ).rejects.toThrowError(
      `\`${agentPath}\` does not export an agent to evaluate.`,
    );
  });
});
