/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  BaseContextCompactor,
  CONTENT_REQUEST_PROCESSOR,
  ContextCompactorRequestProcessor,
  INTERACTIONS_REQUEST_PROCESSOR,
  SingleFlow,
  createSingleFlowRequestProcessors,
  createSingleFlowResponseProcessors,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/agent_transfer_llm_request_processor.js';
import {BASIC_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/basic_llm_request_processor.js';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  responseProcessor as CODE_EXECUTION_RESPONSE_PROCESSOR,
} from '../../../src/agents/processors/code_execution_request_processor.js';

const STUB_COMPACTOR: BaseContextCompactor = {
  shouldCompact: () => false,
  compact: () => {},
};

describe('createSingleFlowRequestProcessors', () => {
  it('runs the interactions processor before the contents processor', () => {
    const processors = createSingleFlowRequestProcessors();

    expect(processors.indexOf(INTERACTIONS_REQUEST_PROCESSOR)).toBeLessThan(
      processors.indexOf(CONTENT_REQUEST_PROCESSOR),
    );
  });

  it('places the compaction processor immediately before the contents processor', () => {
    const processors = createSingleFlowRequestProcessors({
      contextCompactors: [STUB_COMPACTOR],
    });

    const compactionIndex = processors.findIndex(
      (processor) => processor instanceof ContextCompactorRequestProcessor,
    );
    expect(compactionIndex).toBeGreaterThanOrEqual(0);
    expect(processors.indexOf(CONTENT_REQUEST_PROCESSOR)).toBe(
      compactionIndex + 1,
    );
  });

  it('omits the compaction processor when no compactor is supplied', () => {
    const withoutOptions = createSingleFlowRequestProcessors();
    const withEmptyList = createSingleFlowRequestProcessors({
      contextCompactors: [],
    });

    for (const processors of [withoutOptions, withEmptyList]) {
      expect(
        processors.some(
          (processor) => processor instanceof ContextCompactorRequestProcessor,
        ),
      ).toBe(false);
    }
  });

  it('runs the code execution processor after the contents processor', () => {
    const processors = createSingleFlowRequestProcessors();

    expect(
      processors.indexOf(CODE_EXECUTION_REQUEST_PROCESSOR),
    ).toBeGreaterThan(processors.indexOf(CONTENT_REQUEST_PROCESSOR));
  });

  it('starts with the basic processor and includes the auth preprocessor', () => {
    const processors = createSingleFlowRequestProcessors();

    expect(processors[0]).toBe(BASIC_LLM_REQUEST_PROCESSOR);
    expect(processors).toContain(AUTH_PREPROCESSOR);
  });

  it('omits the agent transfer processor', () => {
    const processors = createSingleFlowRequestProcessors({
      contextCompactors: [STUB_COMPACTOR],
    });

    expect(processors).not.toContain(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);
  });

  it('returns a fresh array on every call', () => {
    const first = createSingleFlowRequestProcessors();
    const second = createSingleFlowRequestProcessors();

    expect(first).not.toBe(second);
    first.push(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);
    expect(second).not.toContain(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);
  });
});

describe('createSingleFlowResponseProcessors', () => {
  it('includes the code execution response processor', () => {
    expect(createSingleFlowResponseProcessors()).toContain(
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    );
  });

  it('returns a fresh array on every call', () => {
    const first = createSingleFlowResponseProcessors();
    const second = createSingleFlowResponseProcessors();

    expect(first).not.toBe(second);
    first.length = 0;
    expect(second).toContain(CODE_EXECUTION_RESPONSE_PROCESSOR);
  });
});

describe('SingleFlow', () => {
  it('exposes the processors both factories build', () => {
    const flow = new SingleFlow();

    expect(flow.requestProcessors).toEqual(createSingleFlowRequestProcessors());
    expect(flow.responseProcessors).toEqual(
      createSingleFlowResponseProcessors(),
    );
  });

  it('includes the compaction processor when compactors are supplied', () => {
    const flow = new SingleFlow({contextCompactors: [STUB_COMPACTOR]});

    const compactionIndex = flow.requestProcessors.findIndex(
      (processor) => processor instanceof ContextCompactorRequestProcessor,
    );
    expect(flow.requestProcessors.indexOf(CONTENT_REQUEST_PROCESSOR)).toBe(
      compactionIndex + 1,
    );
  });
});
