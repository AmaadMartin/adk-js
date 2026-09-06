/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AutoFlow,
  BaseContextCompactor,
  CONTENT_REQUEST_PROCESSOR,
  SingleFlow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/agent_transfer_llm_request_processor.js';

const stubCompactor: BaseContextCompactor = {
  shouldCompact: () => false,
  compact: () => {},
};

describe('AutoFlow', () => {
  it('is SingleFlow with the agent transfer processor appended', () => {
    expect(new AutoFlow().requestProcessors).toEqual([
      ...new SingleFlow().requestProcessors,
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    ]);
  });

  it('runs agent transfer last', () => {
    const processors = new AutoFlow().requestProcessors;

    expect(processors[processors.length - 1]).toBe(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });

  it('keeps compaction before the contents and transfer last', () => {
    const processors = new AutoFlow([stubCompactor]).requestProcessors;
    const plain = new SingleFlow().requestProcessors;
    const contentIndex = plain.indexOf(CONTENT_REQUEST_PROCESSOR);

    expect(processors).toEqual([
      ...plain.slice(0, contentIndex),
      processors[contentIndex],
      ...plain.slice(contentIndex),
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    ]);
    expect(plain).not.toContain(processors[contentIndex]);
  });

  it('adds nothing to the response processors', () => {
    expect(new AutoFlow().responseProcessors).toEqual(
      new SingleFlow().responseProcessors,
    );
  });

  it('gives every instance its own arrays', () => {
    const first = new AutoFlow();
    const second = new AutoFlow();

    first.requestProcessors.push(CONTENT_REQUEST_PROCESSOR);

    expect(first.requestProcessors).toHaveLength(
      second.requestProcessors.length + 1,
    );
    expect(first.responseProcessors).not.toBe(second.responseProcessors);
  });
});
