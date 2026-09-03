/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives {@link LocalEvalService} over the real evaluation generator, a real
 * session service and the metric registry that ships with ADK. Only the model
 * is replaced, so the wiring between the service and everything it delegates
 * to is exercised rather than described.
 */

import {
  EvalCase,
  EvalCaseResult,
  EvalStatus,
  InferenceResult,
  InferenceStatus,
  InMemoryEvalSetsManager,
  InMemorySessionService,
  LlmAgent,
  LocalEvalService,
  PrebuiltMetrics,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {RecordingEvalSetResultsManager} from './stub_eval_service.js';
import {ScriptedLlm} from './test_helpers.js';

const APP_NAME = 'home_automation';
const EVAL_SET_ID = 'smoke';
const REPLIES = ['The light is on.', 'The light is off.'];

const EVAL_CASE: EvalCase = {
  evalId: 'two_turns',
  creationTimestamp: 0,
  // The session is created under this app and user, and read back under them
  // when the result is assembled, so naming them is what makes
  // `sessionDetails` resolve.
  sessionInput: {appName: APP_NAME, userId: 'home_user'},
  conversation: [
    {
      invocationId: 'turn-1',
      userContent: {role: 'user', parts: [{text: 'Turn the light on'}]},
      finalResponse: {role: 'model', parts: [{text: REPLIES[0]}]},
    },
    {
      invocationId: 'turn-2',
      userContent: {role: 'user', parts: [{text: 'Turn it off again'}]},
      finalResponse: {role: 'model', parts: [{text: REPLIES[1]}]},
    },
  ],
};

async function buildService(): Promise<{
  service: LocalEvalService;
  evalSetResultsManager: RecordingEvalSetResultsManager;
}> {
  const evalSetsManager = new InMemoryEvalSetsManager();
  await evalSetsManager.createEvalSet(APP_NAME, EVAL_SET_ID);
  await evalSetsManager.addEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE);
  const evalSetResultsManager = new RecordingEvalSetResultsManager();

  return {
    service: new LocalEvalService({
      rootAgent: new LlmAgent({
        name: 'home_agent',
        model: new ScriptedLlm(REPLIES),
      }),
      evalSetsManager,
      evalSetResultsManager,
      sessionService: new InMemorySessionService(),
    }),
    evalSetResultsManager,
  };
}

describe('LocalEvalService over a scripted agent', () => {
  it('runs the agent and scores its tool trajectory', async () => {
    const {service, evalSetResultsManager} = await buildService();

    const inferenceResults: InferenceResult[] = [];
    for await (const result of service.performInference({
      appName: APP_NAME,
      evalSetId: EVAL_SET_ID,
      inferenceConfig: {useLive: false},
    })) {
      inferenceResults.push(result);
    }

    expect(inferenceResults).toHaveLength(1);
    const [inference] = inferenceResults;
    expect(inference.status).toBe(InferenceStatus.SUCCESS);
    expect(inference.inferences).toHaveLength(2);
    expect(
      inference.inferences?.map(
        (invocation) => invocation.finalResponse?.parts?.[0].text,
      ),
    ).toEqual(REPLIES);

    const caseResults: EvalCaseResult[] = [];
    for await (const caseResult of service.evaluate({
      inferenceResults,
      evaluateConfig: {
        evalMetrics: [
          {
            metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
            threshold: 1.0,
          },
        ],
      },
    })) {
      caseResults.push(caseResult);
    }

    expect(caseResults).toHaveLength(1);
    const [caseResult] = caseResults;
    expect(caseResult.evalId).toBe('two_turns');
    expect(caseResult.sessionId).toBe(inference.sessionId);
    expect(caseResult.userId).toBe('home_user');
    expect(caseResult.sessionDetails?.id).toBe(inference.sessionId);
    expect(caseResult.overallEvalMetricResults).toHaveLength(1);
    expect(caseResult.overallEvalMetricResults?.[0].score).toBe(1.0);
    expect(caseResult.finalEvalStatus).toBe(EvalStatus.PASSED);
    expect(caseResult.evalMetricResultPerInvocation).toHaveLength(2);
    expect(evalSetResultsManager.saved).toHaveLength(1);
    expect(evalSetResultsManager.saved[0].evalCaseResults).toEqual(caseResults);
  });
});
