/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlanner,
  BuiltInPlanner,
  Context,
  LlmRequest,
  PlanReActPlanner,
  ReadonlyContext,
  isBasePlanner,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

class CustomPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string {
    return 'Custom instruction';
  }

  override processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] {
    return responseParts;
  }
}

describe('isBasePlanner', () => {
  it('accepts every concrete planner', () => {
    expect(isBasePlanner(new PlanReActPlanner())).toBe(true);
    expect(isBasePlanner(new BuiltInPlanner({thinkingConfig: {}}))).toBe(true);
    expect(isBasePlanner(new CustomPlanner())).toBe(true);
  });

  it('rejects values that are not planners', () => {
    expect(isBasePlanner(undefined)).toBe(false);
    expect(isBasePlanner(null)).toBe(false);
    expect(isBasePlanner({})).toBe(false);
    expect(isBasePlanner('PlanReActPlanner')).toBe(false);
  });

  it('rejects a planner whose brand was removed', () => {
    const planner = new CustomPlanner();
    Object.defineProperty(planner, Symbol.for('google.adk.basePlanner'), {
      value: false,
    });

    expect(isBasePlanner(planner)).toBe(false);
  });
});
