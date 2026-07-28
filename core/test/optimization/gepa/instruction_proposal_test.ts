/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  extractProposedInstruction,
  renderInstructionProposal,
} from '../../../src/optimization/gepa/instruction_proposal.js';

describe('renderInstructionProposal', () => {
  it('substitutes the current text and serialized feedback into the markers', () => {
    const result = renderInstructionProposal({
      currentInstructionDoc: 'DOC',
      datasetWithFeedback: [{score: 1, eval_data: {a: 1}}],
      promptTemplate: 'Current: <curr_param>\nFeedback: <side_info>\nEnd.',
    });

    expect(result).toBe(
      'Current: DOC\nFeedback: [{"score":1,"eval_data":{"a":1}}]\nEnd.',
    );
  });

  it('does not interpret `$` replacement patterns in the current text', () => {
    const result = renderInstructionProposal({
      currentInstructionDoc: 'has $& and $1 tokens',
      datasetWithFeedback: [],
      promptTemplate: '<curr_param>',
    });

    expect(result).toBe('has $& and $1 tokens');
  });

  it('does not interpret `$` replacement patterns in the feedback', () => {
    const result = renderInstructionProposal({
      currentInstructionDoc: 'x',
      datasetWithFeedback: [{v: '$1 $&'}],
      promptTemplate: '<side_info>',
    });

    expect(result).toBe('[{"v":"$1 $&"}]');
  });
});

describe('extractProposedInstruction', () => {
  it('returns the contents of the final fenced block', () => {
    const out =
      'First block:\n```\nold version\n```\nRevised:\n```text\nNEW INSTRUCTION\n```';

    expect(extractProposedInstruction(out)).toBe('NEW INSTRUCTION');
  });

  it('trims whitespace within the fenced block', () => {
    expect(extractProposedInstruction('```\n  spaced text  \n```')).toBe(
      'spaced text',
    );
  });

  it('falls back to the trimmed whole output when no fenced block exists', () => {
    expect(extractProposedInstruction('  just plain text  ')).toBe(
      'just plain text',
    );
  });
});
