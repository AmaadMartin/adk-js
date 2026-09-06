/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlanner, PlanReActPlanner, isBasePlanner} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

/** A planner that contributes no instruction and no post-processing. */
class NoopPlanner extends BasePlanner {
  override buildPlanningInstruction(): string | undefined {
    return undefined;
  }

  override processPlanningResponse(): Part[] | undefined {
    return undefined;
  }
}

describe('isBasePlanner', () => {
  it('accepts a PlanReActPlanner', () => {
    expect(isBasePlanner(new PlanReActPlanner())).toBe(true);
  });

  it('accepts any subclass, so the brand is inherited', () => {
    expect(isBasePlanner(new NoopPlanner())).toBe(true);
  });

  it('rejects values that are not planners', () => {
    expect(isBasePlanner({})).toBe(false);
    expect(isBasePlanner(undefined)).toBe(false);
    expect(isBasePlanner(null)).toBe(false);
    expect(isBasePlanner('x')).toBe(false);
  });
});

describe('BasePlanner subclass contract', () => {
  it('allows a planner to opt out of both hooks', () => {
    const planner = new NoopPlanner();

    expect(planner.buildPlanningInstruction()).toBeUndefined();
    expect(planner.processPlanningResponse()).toBeUndefined();
  });
});
