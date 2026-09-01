/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlanner,
  Context,
  InvocationContext,
  isBasePlanner,
  LlmRequest,
  PluginManager,
  ReadonlyContext,
  Session,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

const PLANNER_SIGNATURE = Symbol.for('google.adk.basePlanner');

function createInvocationContext(): InvocationContext {
  const session: Session = {
    id: 'session-1',
    appName: 'app',
    userId: 'user',
    state: {},
    events: [],
    lastUpdateTime: Date.now(),
  };

  return new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent: {name: 'test_agent'} as BaseAgent,
    pluginManager: new PluginManager(),
  });
}

function createLlmRequest(contents: Content[] = []): LlmRequest {
  return {contents, liveConnectConfig: {}, toolsDict: {}};
}

/** Mirrors `CustomPlanner` in adk-python's NL-planning flow tests. */
class TestPlanner extends BasePlanner {
  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return 'Custom instruction';
  }

  processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    return responseParts;
  }
}

/** Pins the optional half of the contract: both members may return nothing. */
class NoOpPlanner extends BasePlanner {
  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return undefined;
  }

  processPlanningResponse(
    _callbackContext: Context,
    _responseParts: Part[],
  ): Part[] | undefined {
    return undefined;
  }
}

/** Consumes every part, which is distinct from returning nothing. */
class ConsumingPlanner extends BasePlanner {
  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return '';
  }

  processPlanningResponse(
    _callbackContext: Context,
    _responseParts: Part[],
  ): Part[] | undefined {
    return [];
  }
}

/** The planner documented in docs/guides/planners/base_planner/index.md. */
class ThoughtStrippingPlanner extends BasePlanner {
  buildPlanningInstruction(
    readonlyContext: ReadonlyContext,
    llmRequest: LlmRequest,
  ): string | undefined {
    if (llmRequest.contents.length === 0) {
      return undefined;
    }
    return `Plan before you act, ${readonlyContext.agentName}.`;
  }

  processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    return responseParts.filter((part) => !part.thought);
  }
}

/** Writes to the callback context, which `ReadonlyContext` would not allow. */
class StateWritingPlanner extends BasePlanner {
  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return undefined;
  }

  processPlanningResponse(
    callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    callbackContext.state.set('planned', true);
    return responseParts;
  }
}

describe('BasePlanner', () => {
  const invocationContext = createInvocationContext();
  const readonlyContext = new ReadonlyContext(invocationContext);

  function createCallbackContext(): Context {
    return new Context({invocationContext});
  }

  it('returns the instruction built by the subclass', () => {
    const planner = new TestPlanner();

    expect(
      planner.buildPlanningInstruction(readonlyContext, createLlmRequest()),
    ).toBe('Custom instruction');
  });

  it('returns the response parts processed by the subclass', () => {
    const planner = new TestPlanner();
    const parts: Part[] = [{text: 'a'}, {text: 'b', thought: true}];

    expect(
      planner.processPlanningResponse(createCallbackContext(), parts),
    ).toEqual(parts);
  });

  it('accepts undefined from both members', () => {
    const planner = new NoOpPlanner();

    const instruction = planner.buildPlanningInstruction(
      readonlyContext,
      createLlmRequest(),
    );
    const processed = planner.processPlanningResponse(createCallbackContext(), [
      {text: 'a'},
    ]);

    expect(instruction).toBeUndefined();
    expect(processed).toBeUndefined();
  });

  it('keeps an empty result distinct from undefined', () => {
    const planner = new ConsumingPlanner();

    const processed = planner.processPlanningResponse(createCallbackContext(), [
      {text: 'a'},
    ]);

    expect(processed).toEqual([]);
  });

  it('lets a subclass return a new array without mutating the input', () => {
    const planner = new ThoughtStrippingPlanner();
    const parts: Part[] = [{text: 'answer'}, {text: 'thinking', thought: true}];

    const processed = planner.processPlanningResponse(
      createCallbackContext(),
      parts,
    );

    expect(processed).toEqual([{text: 'answer'}]);
    expect(parts).toHaveLength(2);
  });

  it('lets a subclass read both arguments of the request member', () => {
    const planner = new ThoughtStrippingPlanner();
    const request = createLlmRequest([{role: 'user', parts: [{text: 'hi'}]}]);

    expect(planner.buildPlanningInstruction(readonlyContext, request)).toBe(
      'Plan before you act, test_agent.',
    );
    expect(
      planner.buildPlanningInstruction(readonlyContext, createLlmRequest()),
    ).toBeUndefined();
  });

  it('gives the subclass a writable callback context', () => {
    const planner = new StateWritingPlanner();
    const callbackContext = createCallbackContext();

    planner.processPlanningResponse(callbackContext, [{text: 'a'}]);

    expect(callbackContext.state.hasDelta()).toBe(true);
    expect(callbackContext.eventActions.stateDelta['planned']).toBe(true);
  });
});

describe('isBasePlanner', () => {
  it('accepts a subclass instance', () => {
    expect(isBasePlanner(new TestPlanner())).toBe(true);
  });

  it('accepts an object carrying the signature symbol', () => {
    const duck = {[PLANNER_SIGNATURE]: true};

    expect(isBasePlanner(duck)).toBe(true);
  });

  it('rejects an object whose signature symbol is not true', () => {
    const impostor = {[PLANNER_SIGNATURE]: false};

    expect(isBasePlanner(impostor)).toBe(false);
  });

  it('rejects non-planners without throwing', () => {
    expect(isBasePlanner({})).toBe(false);
    expect(isBasePlanner(null)).toBe(false);
    expect(isBasePlanner(undefined)).toBe(false);
    expect(isBasePlanner('planner')).toBe(false);
    expect(isBasePlanner(42)).toBe(false);
    expect(isBasePlanner([])).toBe(false);
    expect(isBasePlanner(Object.create(null))).toBe(false);
  });

  it('narrows an unknown value to BasePlanner', () => {
    const candidate: unknown = new TestPlanner();

    if (!isBasePlanner(candidate)) {
      expect.fail('the guard must accept a BasePlanner subclass');
    }

    expect(
      candidate.buildPlanningInstruction(
        new ReadonlyContext(createInvocationContext()),
        createLlmRequest(),
      ),
    ).toBe('Custom instruction');
  });
});
