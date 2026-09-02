/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalServiceParams,
  getEvalRuntime,
  InMemoryEvalSetsManager,
  LlmAgent,
  MISSING_EVAL_DEPENDENCIES_MESSAGE,
  setEvalRuntime,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';
import {StubEvalRuntime} from './stub_eval_service.js';

function createParams(): EvalServiceParams {
  return {
    rootAgent: new LlmAgent({name: 'root_agent'}),
    evalSetsManager: new InMemoryEvalSetsManager(),
    evalConfig: {criteria: {}},
  };
}

describe('evalRuntime', () => {
  afterEach(() => {
    setEvalRuntime(undefined);
  });

  it('reports the missing runtime when none is installed', () => {
    expect(() => getEvalRuntime()).toThrowError(
      MISSING_EVAL_DEPENDENCIES_MESSAGE,
    );
  });

  it('returns the installed runtime', () => {
    const runtime = new StubEvalRuntime();
    setEvalRuntime(runtime);

    expect(getEvalRuntime()).toBe(runtime);
  });

  it('forwards the params to the installed runtime', () => {
    const runtime = new StubEvalRuntime();
    setEvalRuntime(runtime);
    const params = createParams();

    const service = getEvalRuntime().createEvalService(params);

    expect(runtime.params).toBe(params);
    expect(service).toBe(runtime.service);
  });

  it('uninstalls the runtime when set to undefined', () => {
    setEvalRuntime(new StubEvalRuntime());
    setEvalRuntime(undefined);

    expect(() => getEvalRuntime()).toThrowError(
      MISSING_EVAL_DEPENDENCIES_MESSAGE,
    );
  });
});
