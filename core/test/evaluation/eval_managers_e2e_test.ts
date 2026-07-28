/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCaseResult,
  EvalCaseResultSchema,
  EvalCaseSchema,
  EvalStatus,
  LocalEvalSetResultsManager,
  LocalEvalSetsManager,
} from '@google/adk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

// End-to-end sanity check with no mocks: real filesystem, timers, and UUIDs.
describe('evaluation managers end-to-end (no mocks)', () => {
  let agentsDir: string;

  beforeEach(async () => {
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-eval-e2e-'));
  });

  afterEach(async () => {
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  it('drives the full eval set and result lifecycle on disk', async () => {
    const setsManager = new LocalEvalSetsManager(agentsDir);
    const resultsManager = new LocalEvalSetResultsManager(agentsDir);
    const appName = 'e2e_app';
    const evalSetId = 'e2e_set';

    // Create and list.
    await setsManager.createEvalSet(appName, evalSetId);
    expect(await setsManager.listEvalSets(appName)).toEqual([evalSetId]);

    // Add a case with an opaque tool-call args object.
    const evalCase = EvalCaseSchema.parse({
      evalId: 'case_1',
      conversation: [
        {
          invocationId: 'inv-1',
          userContent: {role: 'user', parts: [{text: 'hi'}]},
          intermediateData: {
            toolUses: [{name: 'lookup', args: {query_text: 'weather'}}],
            toolResponses: [],
            intermediateResponses: [],
          },
        },
      ],
    });
    await setsManager.addEvalCase(appName, evalSetId, evalCase);
    expect(
      (await setsManager.getEvalCase(appName, evalSetId, 'case_1'))?.evalId,
    ).toBe('case_1');

    // Update the case and confirm the change persisted.
    const updatedCase = EvalCaseSchema.parse({
      evalId: 'case_1',
      conversation: [],
      creationTimestamp: 42,
    });
    await setsManager.updateEvalCase(appName, evalSetId, updatedCase);
    expect(
      (await setsManager.getEvalCase(appName, evalSetId, 'case_1'))
        ?.creationTimestamp,
    ).toBe(42);

    // Delete the case.
    await setsManager.deleteEvalCase(appName, evalSetId, 'case_1');
    const emptied = await setsManager.getEvalSet(appName, evalSetId);
    expect(emptied?.evalCases).toEqual([]);

    // Save an eval set result and read it back.
    const caseResults: EvalCaseResult[] = [
      EvalCaseResultSchema.parse({
        evalSetId,
        evalId: 'case_1',
        finalEvalStatus: EvalStatus.PASSED,
        overallEvalMetricResults: [],
        evalMetricResultPerInvocation: [],
        sessionId: 'session-1',
      }),
    ];
    await resultsManager.saveEvalSetResult(appName, evalSetId, caseResults);

    const resultIds = await resultsManager.listEvalSetResults(appName);
    expect(resultIds).toHaveLength(1);

    const retrieved = await resultsManager.getEvalSetResult(
      appName,
      resultIds[0],
    );
    expect(retrieved.evalSetId).toBe(evalSetId);
    expect(retrieved.evalCaseResults[0].finalEvalStatus).toBe(
      EvalStatus.PASSED,
    );
    expect(retrieved.evalCaseResults[0].evalId).toBe('case_1');
  });
});
