/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EvalCase,
  EvalCaseResult,
  EvalMetricResult,
  EvalMetricResultPerInvocation,
  EvalSet,
  EvalSetsManager,
  Invocation,
} from '@google/adk';
import {EvalStatus, InMemoryEvalSetsManager} from '@google/adk';
import type {Content} from '@google/genai';

/** The app every fixture in this suite belongs to. */
export const TEST_APP = 'test_app';

/** Builds an invocation with the given user text and agent text. */
export function createInvocation(
  userContent: Content,
  finalResponse?: Content,
  intermediateData?: Invocation['intermediateData'],
): Invocation {
  return {userContent, finalResponse, intermediateData};
}

/** Builds an eval case that replays one static turn. */
export function createEvalCase(
  evalId: string,
  invocations: Invocation[] = [],
): EvalCase {
  return {evalId, conversation: invocations};
}

/** Builds a metric result. */
export function createMetricResult(
  metricName: string,
  evalStatus: EvalStatus,
  score?: number,
): EvalMetricResult {
  return {metricName, score, evalStatus};
}

/** Builds one invocation's metric results. */
export function createPerInvocationResult(
  actualInvocation: Invocation,
  evalMetricResults: EvalMetricResult[],
  expectedInvocation?: Invocation,
): EvalMetricResultPerInvocation {
  return {actualInvocation, evalMetricResults, expectedInvocation};
}

/** Builds an eval case result. */
export function createEvalCaseResult(
  evalId: string,
  finalEvalStatus: EvalStatus,
  evalMetricResultPerInvocation: EvalMetricResultPerInvocation[] = [],
  evalSetId = 'train_set',
): EvalCaseResult {
  return {
    evalSetId,
    evalId,
    finalEvalStatus,
    evalMetricResultPerInvocation,
    sessionId: `${evalId}_session`,
  };
}

/**
 * Builds a manager holding one eval set per id, each with the two eval cases
 * `<id>_1` and `<id>_2`.
 */
export async function createManagerWithSets(
  evalSetIds: string[],
  appName = TEST_APP,
): Promise<InMemoryEvalSetsManager> {
  const manager = new InMemoryEvalSetsManager();
  for (const evalSetId of evalSetIds) {
    await manager.createEvalSet(appName, evalSetId);
    for (const suffix of ['1', '2']) {
      await manager.addEvalCase(
        appName,
        evalSetId,
        createEvalCase(`${evalSetId}_${suffix}`),
      );
    }
  }
  return manager;
}

/**
 * An eval sets manager whose two read methods answer from fixed maps.
 *
 * `LocalEvalSampler` only ever reads, so the write methods reject rather than
 * pretend to store anything.
 */
export class ReadOnlyEvalSetsManager implements EvalSetsManager {
  constructor(
    private readonly evalSets: Map<string, EvalSet> = new Map(),
    private readonly evalCases: Map<string, EvalCase> = new Map(),
  ) {}

  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    return this.evalSets.get(`${appName}/${evalSetId}`);
  }

  async getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined> {
    return this.evalCases.get(`${appName}/${evalSetId}/${evalCaseId}`);
  }

  async listEvalSets(appName: string): Promise<string[]> {
    return [...this.evalSets.keys()]
      .filter((key) => key.startsWith(`${appName}/`))
      .map((key) => key.slice(appName.length + 1));
  }

  async createEvalSet(): Promise<EvalSet> {
    throw new Error('ReadOnlyEvalSetsManager does not create eval sets.');
  }

  async addEvalCase(): Promise<void> {
    throw new Error('ReadOnlyEvalSetsManager does not add eval cases.');
  }

  async updateEvalCase(): Promise<void> {
    throw new Error('ReadOnlyEvalSetsManager does not update eval cases.');
  }

  async deleteEvalCase(): Promise<void> {
    throw new Error('ReadOnlyEvalSetsManager does not delete eval cases.');
  }
}
