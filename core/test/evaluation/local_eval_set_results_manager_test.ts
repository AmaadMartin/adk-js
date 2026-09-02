/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCaseResult,
  EvalStatus,
  InputValidationError,
  LocalEvalSetResultsManager,
  NotFoundError,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  // Wrapping the real functions keeps every other test on the real file
  // system, while letting one test make a single call fail.
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    writeFile: vi.fn(actual.writeFile),
  };
});

const APP_NAME = 'home_automation';
const EVAL_SET_ID = 'smoke';

const CASE_RESULT: EvalCaseResult = {
  evalSetId: EVAL_SET_ID,
  evalId: 'lights_on',
  finalEvalStatus: EvalStatus.PASSED,
  evalMetricResultPerInvocation: [],
};

let agentsDir: string;
let manager: LocalEvalSetResultsManager;

function historyDir(appName = APP_NAME): string {
  return path.join(agentsDir, appName, '.adk', 'eval_history');
}

async function listHistoryFiles(): Promise<string[]> {
  return (await fs.readdir(historyDir())).sort();
}

beforeEach(async () => {
  agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-eval-results-'));
  manager = new LocalEvalSetResultsManager(agentsDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(agentsDir, {recursive: true, force: true});
});

describe('LocalEvalSetResultsManager', () => {
  it('writes one result file under the eval history directory', async () => {
    await manager.saveEvalSetResult(APP_NAME, EVAL_SET_ID, [CASE_RESULT]);

    const files = await listHistoryFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(
      new RegExp(
        `^${APP_NAME}_${EVAL_SET_ID}_[0-9.]+\\.evalset_result\\.json$`,
      ),
    );
    const written = JSON.parse(
      await fs.readFile(path.join(historyDir(), files[0]), 'utf-8'),
    );
    expect(written).toMatchObject({
      eval_set_id: EVAL_SET_ID,
      eval_case_results: [{eval_id: 'lights_on', final_eval_status: 1}],
    });
  });

  it('reads back a result it saved', async () => {
    await manager.saveEvalSetResult(APP_NAME, EVAL_SET_ID, [CASE_RESULT]);
    const [savedId] = await manager.listEvalSetResults(APP_NAME);

    const result = await manager.getEvalSetResult(APP_NAME, savedId);

    expect(result.evalSetResultId).toBe(savedId);
    expect(result.evalSetId).toBe(EVAL_SET_ID);
    expect(result.creationTimestamp).toBeGreaterThan(0);
    expect(result.evalCaseResults).toEqual([CASE_RESULT]);
  });

  it('reports a result id it does not hold', async () => {
    await expect(
      manager.getEvalSetResult(APP_NAME, 'never_saved'),
    ).rejects.toThrowError(
      new NotFoundError('Eval set result `never_saved` not found.'),
    );
  });

  it('reports no results for an app with no eval history', async () => {
    expect(await manager.listEvalSetResults('unknown')).toEqual([]);
  });

  it('surfaces a listing failure that is not a missing directory', async () => {
    const failure = Object.assign(new Error('disk on fire'), {code: 'EIO'});
    vi.mocked(fs.readdir).mockRejectedValueOnce(failure);

    await expect(manager.listEvalSetResults(APP_NAME)).rejects.toBe(failure);
  });

  it('surfaces a result file that does not hold a result', async () => {
    await fs.mkdir(historyDir(), {recursive: true});
    await fs.writeFile(
      path.join(historyDir(), 'broken.evalset_result.json'),
      '42',
      'utf-8',
    );

    await expect(
      manager.getEvalSetResult(APP_NAME, 'broken'),
    ).rejects.toThrowError('An eval set result must be a JSON object.');
  });

  it('lists only result files, without their suffix', async () => {
    await fs.mkdir(historyDir(), {recursive: true});
    await fs.writeFile(
      path.join(historyDir(), 'run_a.evalset_result.json'),
      '{}',
      'utf-8',
    );
    await fs.writeFile(path.join(historyDir(), 'notes.txt'), 'x', 'utf-8');

    expect(await manager.listEvalSetResults(APP_NAME)).toEqual(['run_a']);
  });

  it('reads a legacy double-encoded result file', async () => {
    await fs.mkdir(historyDir(), {recursive: true});
    const inner = JSON.stringify({
      eval_set_result_id: 'legacy_run',
      eval_set_id: EVAL_SET_ID,
      eval_case_results: [],
      creation_timestamp: 7,
    });
    await fs.writeFile(
      path.join(historyDir(), 'legacy_run.evalset_result.json'),
      JSON.stringify(inner),
      'utf-8',
    );

    const result = await manager.getEvalSetResult(APP_NAME, 'legacy_run');

    expect(result.evalSetResultId).toBe('legacy_run');
    expect(result.creationTimestamp).toBe(7);
  });

  it('refuses identifiers that walk out of the agents directory', async () => {
    await expect(
      manager.saveEvalSetResult('../escape', EVAL_SET_ID, []),
    ).rejects.toThrow(InputValidationError);
    await expect(
      manager.saveEvalSetResult(APP_NAME, '../escape', []),
    ).rejects.toThrow(InputValidationError);
    await expect(
      manager.getEvalSetResult(APP_NAME, '../escape'),
    ).rejects.toThrow(InputValidationError);
    await expect(manager.listEvalSetResults('../escape')).rejects.toThrow(
      InputValidationError,
    );
  });
});
