/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The renderer and the extractor against the `gepa` package's
 * `InstructionProposalSignature`, read from
 * `src/gepa/strategies/instruction_proposal.py` on `gepa-ai/gepa` `main`.
 */

import {
  AGENT_PROMPT_NAME,
  extractNewInstruction,
  renderProposalPrompt,
  skillComponentKey,
  validateProposalTemplate,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** Returns the text the renderer substituted for `<side_info>`. */
function sideInfoOf(prompt: string): string {
  const sections = prompt.split('```');
  expect(sections.length).toBeGreaterThanOrEqual(5);
  return sections[3];
}

/** Renders the agent template over one dataset and returns its `<side_info>`. */
function renderSideInfo(dataset: Array<Record<string, unknown>>): string {
  return sideInfoOf(
    renderProposalPrompt(AGENT_PROMPT_NAME, 'Current', dataset),
  );
}

describe('renderProposalPrompt', () => {
  it('renders a scalar, a nested object and an array as markdown', () => {
    const sideInfo = renderSideInfo([
      {
        score: 1,
        eval_data: {question: 'Where is my order?', nested: {depth: 'two'}},
        tags: ['refund', 'order'],
      },
    ]);

    expect(sideInfo).toBe(
      '\n# Example 1\n' +
        '## score\n1\n\n' +
        '## eval_data\n' +
        '### question\nWhere is my order?\n\n' +
        '### nested\n#### depth\ntwo\n\n' +
        '## tags\n### Item 1\nrefund\n\n### Item 2\norder\n\n' +
        '\n',
    );
  });

  it('stops indenting at the sixth header level', () => {
    const sideInfo = renderSideInfo([
      {a: {b: {c: {d: {e: {f: {g: 'deep'}}}}}}},
    ]);

    expect(sideInfo).toContain('###### f\n###### g\ndeep');
    expect(sideInfo).not.toContain('#######');
  });

  it('renders an empty object and an empty array as a bare newline', () => {
    const sideInfo = renderSideInfo([{empty_object: {}, empty_array: []}]);

    expect(sideInfo).toBe(
      '\n# Example 1\n## empty_object\n\n## empty_array\n\n\n',
    );
  });

  it('renders an empty dataset as an empty side info', () => {
    expect(renderSideInfo([])).toBe('\n\n');
  });

  it('joins two samples with a blank line', () => {
    const sideInfo = renderSideInfo([{score: 1}, {score: 0}]);

    expect(sideInfo).toBe(
      '\n# Example 1\n## score\n1\n\n\n\n# Example 2\n## score\n0\n\n\n',
    );
  });

  it('substitutes every occurrence of a placeholder', () => {
    // The current text is substituted first, so the side-info placeholder it
    // carries joins the template's own. Python's `str.replace` fills in both.
    const prompt = renderProposalPrompt(
      AGENT_PROMPT_NAME,
      'Report the <side_info> verbatim.',
      [{score: 1}],
    );

    expect(prompt).not.toContain('<side_info>');
    expect(prompt.split('# Example 1')).toHaveLength(3);
  });

  it('substitutes the current text before the side info', () => {
    // A rendered dataset value carrying the current-text placeholder is left
    // alone, because that substitution has already run.
    const prompt = renderProposalPrompt(AGENT_PROMPT_NAME, 'Current', [
      {note: 'the <curr_param> marker'},
    ]);

    expect(prompt.split('<curr_param>')).toHaveLength(2);
    expect(prompt.split('Current')).toHaveLength(2);
  });

  it('substitutes text carrying $ patterns literally', () => {
    const prompt = renderProposalPrompt(
      AGENT_PROMPT_NAME,
      'Quote the total as $& and $1.',
      [],
    );

    expect(prompt).toContain('Quote the total as $& and $1.');
  });

  it('carries the skill name into the skill template', () => {
    const prompt = renderProposalPrompt(
      skillComponentKey('refunds'),
      'Refund instructions',
      [],
    );

    expect(prompt).toContain('a skill named `refunds`');
    expect(prompt).not.toContain('{skill_name}');
  });

  it('rejects a component that is neither the prompt nor a skill', () => {
    expect(() => renderProposalPrompt('mystery', 'text', [])).toThrow(
      'Unknown component type for update: mystery',
    );
  });
});

describe('validateProposalTemplate', () => {
  it('accepts a template carrying both placeholders', () => {
    expect(() =>
      validateProposalTemplate('a <curr_param> b <side_info> c'),
    ).not.toThrow();
  });

  it('names every missing placeholder in order', () => {
    expect(() => validateProposalTemplate('nothing here')).toThrow(
      'Missing placeholder(s) in prompt template: <curr_param>, <side_info>',
    );
  });

  it('names only the placeholder the template lacks', () => {
    expect(() => validateProposalTemplate('only <curr_param>')).toThrow(
      'Missing placeholder(s) in prompt template: <side_info>',
    );
  });
});

describe('extractNewInstruction', () => {
  const cases: Array<{name: string; reply: string; expected: string}> = [
    {
      name: 'returns the whole reply, trimmed, when it carries no fence',
      reply: '  Just prose.  ',
      expected: 'Just prose.',
    },
    {
      name: 'drops a lone opening fence',
      reply: '```\nNew instruction',
      expected: 'New instruction',
    },
    {
      name: 'drops a lone opening fence and its language tag',
      reply: '```md\nNew instruction',
      expected: 'New instruction',
    },
    {
      name: 'keeps a lone opening fence that leading whitespace hides',
      reply: '  ```\nNew instruction',
      expected: '```\nNew instruction',
    },
    {
      name: 'drops a lone closing fence',
      reply: 'New instruction\n```',
      expected: 'New instruction',
    },
    {
      name: 'reads the body of a single fenced block',
      reply: '```\nNew instruction\n```',
      expected: 'New instruction',
    },
    {
      name: 'drops the language tag of a fenced block',
      reply: '```md\nNew instruction\n```',
      expected: 'New instruction',
    },
    {
      name: 'reads the span between the first and last of three fences',
      reply: '```\nA\n```\nmiddle\n```\nB\n```',
      expected: 'A\n```\nmiddle\n```\nB',
    },
    {
      name: 'reads an inline fenced span that carries no newline',
      reply: '```New instruction```',
      expected: 'New instruction',
    },
    {
      name: 'drops the prose surrounding a fenced block',
      reply: 'Here you go:\n```\nNew instruction\n```\nHope that helps.',
      expected: 'New instruction',
    },
  ];

  it.each(cases)('$name', ({reply, expected}) => {
    expect(extractNewInstruction(reply)).toBe(expected);
  });
});
