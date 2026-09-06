/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlanner,
  BuildPlanningInstructionParams,
  Context,
  createSession,
  InvocationContext,
  isBasePlanner,
  LlmRequest,
  PluginManager,
  ProcessPlanningResponseParams,
  ReadonlyContext,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

const INSTRUCTION = 'Plan the steps before you answer.';

class TestPlanner extends BasePlanner {
  buildParams?: BuildPlanningInstructionParams;
  processParams?: ProcessPlanningResponseParams;

  buildPlanningInstruction(
    params: BuildPlanningInstructionParams,
  ): string | undefined {
    this.buildParams = params;
    return INSTRUCTION;
  }

  processPlanningResponse(
    params: ProcessPlanningResponseParams,
  ): Part[] | undefined {
    this.processParams = params;
    params.responseParts[0].thought = true;
    return params.responseParts;
  }
}

/** A planner that needs neither an instruction nor any post-processing. */
class SilentPlanner extends BasePlanner {
  buildPlanningInstruction(
    _params: BuildPlanningInstructionParams,
  ): string | undefined {
    return undefined;
  }

  processPlanningResponse(
    _params: ProcessPlanningResponseParams,
  ): Part[] | undefined {
    return undefined;
  }
}

class PlainAgent extends BaseAgent {
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new PlainAgent({name: 'test_agent'}),
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

/** Builds an object carrying only the signature symbol, as a second copy of
 * the package would produce. */
function createForeignPlanner(signature: unknown): object {
  const foreign = {};
  Object.defineProperty(foreign, Symbol.for('google.adk.basePlanner'), {
    value: signature,
    enumerable: true,
  });
  return foreign;
}

describe('isBasePlanner', () => {
  it('identifies a subclass instance', () => {
    expect(isBasePlanner(new TestPlanner())).toBe(true);
  });

  it('rejects values that are not planners', () => {
    expect(isBasePlanner({})).toBe(false);
    expect(isBasePlanner(null)).toBe(false);
    expect(isBasePlanner(undefined)).toBe(false);
    expect(isBasePlanner('planner')).toBe(false);
    expect(isBasePlanner(42)).toBe(false);
  });

  it('rejects an object that only has the planner methods', () => {
    const lookalike = {
      buildPlanningInstruction: () => INSTRUCTION,
      processPlanningResponse: () => undefined,
    };

    expect(isBasePlanner(lookalike)).toBe(false);
  });

  it('accepts a planner built by another copy of the package', () => {
    expect(isBasePlanner(createForeignPlanner(true))).toBe(true);
  });

  it('rejects a signature that is not true', () => {
    expect(isBasePlanner(createForeignPlanner(false))).toBe(false);
  });
});

describe('BasePlanner', () => {
  it('hands the build parameters to the subclass and returns its instruction', () => {
    const planner = new TestPlanner();
    const readonlyContext = new ReadonlyContext(createInvocationContext());
    const llmRequest = createLlmRequest();

    const instruction = planner.buildPlanningInstruction({
      readonlyContext,
      llmRequest,
    });

    expect(instruction).toBe(INSTRUCTION);
    expect(planner.buildParams?.readonlyContext).toBe(readonlyContext);
    expect(planner.buildParams?.llmRequest).toBe(llmRequest);
  });

  it('hands the response parameters to the subclass and returns its parts', () => {
    const planner = new TestPlanner();
    const context = new Context({
      invocationContext: createInvocationContext(),
    });
    const responseParts: Part[] = [{text: 'reasoning'}, {text: 'answer'}];

    const processed = planner.processPlanningResponse({
      context,
      responseParts,
    });

    expect(processed).toBe(responseParts);
    expect(planner.processParams?.context).toBe(context);
    expect(responseParts[0].thought).toBe(true);
    expect(responseParts[1].thought).toBeUndefined();
  });

  it('lets a planner answer that it needs nothing', () => {
    const planner = new SilentPlanner();
    const readonlyContext = new ReadonlyContext(createInvocationContext());
    const context = new Context({
      invocationContext: createInvocationContext(),
    });

    expect(
      planner.buildPlanningInstruction({
        readonlyContext,
        llmRequest: createLlmRequest(),
      }),
    ).toBeUndefined();
    expect(
      planner.processPlanningResponse({context, responseParts: [{text: 'a'}]}),
    ).toBeUndefined();
  });
});
