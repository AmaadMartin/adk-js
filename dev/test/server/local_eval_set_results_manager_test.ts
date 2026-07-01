/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  EvalCaseResult,
  EvalSetResult,
} from '../../src/server/evaluation_types.js';
import {LocalEvalSetResultsManager} from '../../src/server/local_eval_set_results_manager.js';
import {NotFoundError} from '../../src/server/local_eval_sets_manager.js';

describe('LocalEvalSetResultsManager', () => {
  let tempDir: string;
  let manager: LocalEvalSetResultsManager;
  const appName = 'testApp';

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'adk-eval-results-test-'),
    );
    manager = new LocalEvalSetResultsManager(tempDir);
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, {recursive: true, force: true});
  });

  describe('saveEvalSetResult', () => {
    it('should save a new eval set result', async () => {
      const evalSetId = 'test_set';
      const caseResults: EvalCaseResult[] = [
        {
          evalSetFile: 'test_set.evalset.json',
          evalSetId: evalSetId,
          evalId: 'case_1',
          finalEvalStatus: 'PASSED',
          overallEvalMetricResults: [],
          evalMetricResultPerInvocation: [],
          sessionId: 'sess_1',
          userId: 'user_1',
        },
      ];

      const result = await manager.saveEvalSetResult(
        appName,
        evalSetId,
        caseResults,
      );

      expect(result.evalSetId).toBe(evalSetId);
      expect(result.evalSetResultId).toContain(`${appName}_${evalSetId}_`);
      expect(result.evalSetResultName).toBe(
        result.evalSetResultId.replace(/\//g, '_'),
      );
      expect(result.evalCaseResults).toEqual(caseResults);
      expect(result.creationTimestamp).toBeGreaterThan(0);

      const filePath = path.join(
        tempDir,
        appName,
        '.adk/eval_history',
        `${result.evalSetResultName}.evalset_result.json`,
      );

      const fileContent = await fsPromises.readFile(filePath, 'utf-8');
      const savedResult = JSON.parse(fileContent) as EvalSetResult;

      expect(savedResult.evalSetId).toBe(evalSetId);
      expect(savedResult.evalSetResultId).toBe(result.evalSetResultId);
      expect(savedResult.evalCaseResults.length).toBe(1);
      expect(savedResult.evalCaseResults[0].evalId).toBe('case_1');
    });
  });

  describe('getEvalSetResult', () => {
    it('should error if result does not exist', async () => {
      await expect(
        manager.getEvalSetResult(appName, 'non_existent'),
      ).rejects.toThrow(NotFoundError);
    });

    it('should return the result if it exists', async () => {
      const evalSetId = 'test_set';
      const saved = await manager.saveEvalSetResult(appName, evalSetId, []);

      const result = await manager.getEvalSetResult(
        appName,
        saved.evalSetResultName,
      );
      expect(result).toBeDefined();
      expect(result.evalSetResultName).toBe(saved.evalSetResultName);
    });

    it('should handle double-encoded JSON', async () => {
      const resultName = 'double_encoded';
      const resultData: EvalSetResult = {
        evalSetResultId: 'id1',
        evalSetResultName: resultName,
        evalSetId: 'set1',
        evalCaseResults: [],
        creationTimestamp: 123456,
      };

      const historyDir = path.join(tempDir, appName, '.adk/eval_history');
      await fsPromises.mkdir(historyDir, {recursive: true});
      await fsPromises.writeFile(
        path.join(historyDir, `${resultName}.evalset_result.json`),
        JSON.stringify(JSON.stringify(resultData)),
        'utf-8',
      );

      const result = await manager.getEvalSetResult(appName, resultName);
      expect(result).toBeDefined();
      expect(result.evalSetResultId).toBe('id1');
      expect(result.evalSetId).toBe('set1');
    });
  });

  describe('listEvalSetResults', () => {
    it('should return empty list if history directory does not exist', async () => {
      const list = await manager.listEvalSetResults(appName);
      expect(list).toEqual([]);
    });

    it('should list result IDs sorted', async () => {
      const saved1 = await manager.saveEvalSetResult(appName, 'set_1', []);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const saved2 = await manager.saveEvalSetResult(appName, 'set_1', []);

      const list = await manager.listEvalSetResults(appName);
      expect(list.length).toBe(2);
      expect(list).toEqual(
        [saved1.evalSetResultName, saved2.evalSetResultName].sort(),
      );
    });
  });
});
