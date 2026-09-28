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

describe('SingleFlow request processors', () => {
  it('runs the interactions processor before the contents processor', () => {
    const {requestProcessors} = new SingleFlow();

    expect(
      requestProcessors.indexOf(INTERACTIONS_REQUEST_PROCESSOR),
    ).toBeLessThan(requestProcessors.indexOf(CONTENT_REQUEST_PROCESSOR));
  });

  it('places the compaction processor immediately before the contents processor', () => {
    const {requestProcessors} = new SingleFlow([STUB_COMPACTOR]);

    const compactionIndex = requestProcessors.findIndex(
      (processor) => processor instanceof ContextCompactorRequestProcessor,
    );
    expect(compactionIndex).toBeGreaterThanOrEqual(0);
    expect(requestProcessors.indexOf(CONTENT_REQUEST_PROCESSOR)).toBe(
      compactionIndex + 1,
    );
  });

  it('omits the compaction processor when no compactor is supplied', () => {
    const withoutArgument = new SingleFlow();
    const withEmptyList = new SingleFlow([]);

    for (const flow of [withoutArgument, withEmptyList]) {
      expect(
        flow.requestProcessors.some(
          (processor) => processor instanceof ContextCompactorRequestProcessor,
        ),
      ).toBe(false);
    }
  });

  it('runs the code execution processor after the contents processor', () => {
    const {requestProcessors} = new SingleFlow();

    expect(
      requestProcessors.indexOf(CODE_EXECUTION_REQUEST_PROCESSOR),
    ).toBeGreaterThan(requestProcessors.indexOf(CONTENT_REQUEST_PROCESSOR));
  });

  it('starts with the basic processor and includes the auth preprocessor', () => {
    const {requestProcessors} = new SingleFlow();

    expect(requestProcessors[0]).toBe(BASIC_LLM_REQUEST_PROCESSOR);
    expect(requestProcessors).toContain(AUTH_PREPROCESSOR);
  });

  it('omits the agent transfer processor', () => {
    const {requestProcessors} = new SingleFlow([STUB_COMPACTOR]);

    expect(requestProcessors).not.toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });

  it('gives every instance its own array', () => {
    const first = new SingleFlow();
    const second = new SingleFlow();

    expect(first.requestProcessors).not.toBe(second.requestProcessors);
    first.requestProcessors.push(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);
    expect(second.requestProcessors).not.toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });
});

describe('SingleFlow response processors', () => {
  it('includes the code execution response processor', () => {
    expect(new SingleFlow().responseProcessors).toContain(
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    );
  });

  it('gives every instance its own array', () => {
    const first = new SingleFlow();
    const second = new SingleFlow();

    expect(first.responseProcessors).not.toBe(second.responseProcessors);
    first.responseProcessors.length = 0;
    expect(second.responseProcessors).toContain(
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    );
  });
});
