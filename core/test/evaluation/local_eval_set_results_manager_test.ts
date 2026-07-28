/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ADK_EVAL_HISTORY_DIR,
  EVAL_SET_RESULT_FILE_EXTENSION,
  EvalCaseResult,
  EvalCaseResultSchema,
  EvalSetResult,
  EvalSetResultSchema,
  EvalStatus,
  LocalEvalSetResultsManager,
  NotFoundError,
} from '@google/adk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as envAwareUtils from '../../src/utils/env_aware_utils.js';

vi.mock('../../src/utils/env_aware_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/env_aware_utils.js')>();
  return {...actual, nowSeconds: vi.fn(() => actual.nowSeconds())};
});

const APP_NAME = 'test_app';
const EVAL_SET_ID = 'test_eval_set';
const TIMESTAMP = 1700000000.5;
const INVALID_SEGMENTS = ['', '.', '..', 'foo/bar', 'foo\\bar'];

function makeEvalCaseResult(evalId: string, sessionId: string): EvalCaseResult {
  return EvalCaseResultSchema.parse({
    evalSetFile: 'test_file',
    evalSetId: EVAL_SET_ID,
    evalId,
    finalEvalStatus: EvalStatus.PASSED,
    overallEvalMetricResults: [],
    evalMetricResultPerInvocation: [],
    sessionId,
  });
}

describe('evaluation/local_eval_set_results_manager', () => {
  let tempDir: string;
  let agentsDir: string;
  let manager: LocalEvalSetResultsManager;
  let evalCaseResults: EvalCaseResult[];
  let resultName: string;
  let expectedResult: EvalSetResult;

  beforeEach(async () => {
    vi.mocked(envAwareUtils.nowSeconds).mockReturnValue(TIMESTAMP);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-eval-results-'));
    agentsDir = path.join(tempDir, 'agents');
    await fs.mkdir(agentsDir, {recursive: true});
    manager = new LocalEvalSetResultsManager(agentsDir);
    evalCaseResults = [makeEvalCaseResult('case1', 'session1')];
    resultName = `${APP_NAME}_${EVAL_SET_ID}_${TIMESTAMP}`;
    expectedResult = EvalSetResultSchema.parse({
      evalSetResultId: resultName,
      evalSetResultName: resultName,
      evalSetId: EVAL_SET_ID,
      evalCaseResults,
      creationTimestamp: TIMESTAMP,
    });
  });

  afterEach(async () => {
    vi.mocked(envAwareUtils.nowSeconds).mockReset();
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  it('saves an eval set result as a snake_case JSON object', async () => {
    await manager.saveEvalSetResult(APP_NAME, EVAL_SET_ID, evalCaseResults);

    const filePath = path.join(
      agentsDir,
      APP_NAME,
      ADK_EVAL_HISTORY_DIR,
      resultName + EVAL_SET_RESULT_FILE_EXTENSION,
    );
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(onDisk).toEqual({
      eval_set_result_id: resultName,
      eval_set_result_name: resultName,
      eval_set_id: EVAL_SET_ID,
      eval_case_results: [
        {
          eval_set_file: 'test_file',
          eval_set_id: EVAL_SET_ID,
          eval_id: 'case1',
          final_eval_status: 1,
          overall_eval_metric_results: [],
          eval_metric_result_per_invocation: [],
          session_id: 'session1',
        },
      ],
      creation_timestamp: TIMESTAMP,
    });
  });

  it.each(INVALID_SEGMENTS)(
    'rejects saving with invalid app name %j',
    async (appName) => {
      await expect(
        manager.saveEvalSetResult(appName, EVAL_SET_ID, evalCaseResults),
      ).rejects.toThrow();
    },
  );

  it.each(INVALID_SEGMENTS)(
    'rejects saving with invalid eval set id %j',
    async (evalSetId) => {
      await expect(
        manager.saveEvalSetResult(APP_NAME, evalSetId, evalCaseResults),
      ).rejects.toThrow();
    },
  );

  it('round-trips an eval set result through save and get', async () => {
    await manager.saveEvalSetResult(APP_NAME, EVAL_SET_ID, evalCaseResults);
    const retrieved = await manager.getEvalSetResult(APP_NAME, resultName);
    expect(retrieved).toEqual(expectedResult);
  });

  it.each(INVALID_SEGMENTS)(
    'rejects getting with invalid app name %j',
    async (appName) => {
      await expect(
        manager.getEvalSetResult(appName, resultName),
      ).rejects.toThrow();
    },
  );

  it.each(INVALID_SEGMENTS)(
    'rejects getting with invalid eval set result id %j',
    async (resultId) => {
      await expect(
        manager.getEvalSetResult(APP_NAME, resultId),
      ).rejects.toThrow();
    },
  );

  it('reads a legacy double-encoded result file', async () => {
    const historyDir = path.join(agentsDir, APP_NAME, ADK_EVAL_HISTORY_DIR);
    await fs.mkdir(historyDir, {recursive: true});
    const filePath = path.join(
      historyDir,
      resultName + EVAL_SET_RESULT_FILE_EXTENSION,
    );
    const innerJson = JSON.stringify({
      eval_set_result_id: resultName,
      eval_set_result_name: resultName,
      eval_set_id: EVAL_SET_ID,
      eval_case_results: [
        {
          eval_set_file: 'test_file',
          eval_set_id: EVAL_SET_ID,
          eval_id: 'case1',
          final_eval_status: 1,
          overall_eval_metric_results: [],
          eval_metric_result_per_invocation: [],
          session_id: 'session1',
        },
      ],
      creation_timestamp: TIMESTAMP,
    });
    await fs.writeFile(filePath, JSON.stringify(innerJson), 'utf-8');

    const retrieved = await manager.getEvalSetResult(APP_NAME, resultName);
    expect(retrieved).toEqual(expectedResult);
  });

  it('throws NotFoundError for a missing result', async () => {
    await expect(
      manager.getEvalSetResult(APP_NAME, 'non_existent_id'),
    ).rejects.toThrow(NotFoundError);
  });

  it('lists results for a single app without leaking other apps', async () => {
    await manager.saveEvalSetResult(APP_NAME, EVAL_SET_ID, evalCaseResults);

    const secondTimestamp = TIMESTAMP + 1;
    vi.mocked(envAwareUtils.nowSeconds).mockReturnValue(secondTimestamp);
    await manager.saveEvalSetResult(APP_NAME, EVAL_SET_ID, [
      makeEvalCaseResult('case2', 'session2'),
    ]);

    const thirdTimestamp = TIMESTAMP + 2;
    vi.mocked(envAwareUtils.nowSeconds).mockReturnValue(thirdTimestamp);
    await manager.saveEvalSetResult(
      'another_app',
      EVAL_SET_ID,
      evalCaseResults,
    );

    const results = await manager.listEvalSetResults(APP_NAME);
    expect(new Set(results)).toEqual(
      new Set([resultName, `${APP_NAME}_${EVAL_SET_ID}_${secondTimestamp}`]),
    );
  });

  it('returns an empty list when there are no results', async () => {
    expect(await manager.listEvalSetResults(APP_NAME)).toEqual([]);
  });

  it('propagates non-ENOENT errors when reading a result', async () => {
    const historyDir = path.join(agentsDir, APP_NAME, ADK_EVAL_HISTORY_DIR);
    await fs.mkdir(historyDir, {recursive: true});
    // Create a directory where the result file is expected so reading it fails
    // with a non-ENOENT error (EISDIR) that must propagate.
    await fs.mkdir(
      path.join(historyDir, resultName + EVAL_SET_RESULT_FILE_EXTENSION),
    );
    await expect(
      manager.getEvalSetResult(APP_NAME, resultName),
    ).rejects.not.toBeInstanceOf(NotFoundError);
  });

  it('propagates non-ENOENT errors when listing results', async () => {
    // Make the eval history path a file so readdir fails with ENOTDIR.
    await fs.mkdir(path.join(agentsDir, APP_NAME, '.adk'), {recursive: true});
    await fs.writeFile(
      path.join(agentsDir, APP_NAME, ADK_EVAL_HISTORY_DIR),
      'not a directory',
      'utf-8',
    );
    await expect(manager.listEvalSetResults(APP_NAME)).rejects.toThrow();
  });
});
