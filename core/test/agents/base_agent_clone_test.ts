/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, isLlmAgent} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('BaseAgent.clone', () => {
  it('creates a detached copy that preserves fields', () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      description: 'A root agent',
      instruction: 'Original instruction',
    });

    const cloned = agent.clone();

    expect(cloned).not.toBe(agent);
    expect(cloned).toBeInstanceOf(LlmAgent);
    expect(isLlmAgent(cloned)).toBe(true);
    expect(cloned.name).toBe('root_agent');
    expect(cloned.description).toBe('A root agent');
    expect(cloned.instruction).toBe('Original instruction');
    expect(cloned.parentAgent).toBeUndefined();
    expect(cloned.subAgents).toEqual([]);
  });

  it('applies field overrides without mutating the original', () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      instruction: 'Original instruction',
    });

    const cloned = agent.clone({instruction: 'Updated instruction'});

    expect(cloned.instruction).toBe('Updated instruction');
    expect(agent.instruction).toBe('Original instruction');
  });

  it('recursively clones and re-parents sub-agents', () => {
    const child = new LlmAgent({name: 'child_agent', instruction: 'Child'});
    const parent = new LlmAgent({
      name: 'parent_agent',
      instruction: 'Parent',
      subAgents: [child],
    });

    const cloned = parent.clone();

    expect(cloned.subAgents).toHaveLength(1);
    const clonedChild = cloned.subAgents[0];
    expect(clonedChild).not.toBe(child);
    expect(clonedChild.name).toBe('child_agent');
    expect(clonedChild.parentAgent).toBe(cloned);

    // The original tree is untouched.
    expect(parent.subAgents[0]).toBe(child);
    expect(child.parentAgent).toBe(parent);
  });

  it('throws when attempting to override parentAgent', () => {
    const agent = new LlmAgent({name: 'root_agent', instruction: 'Original'});

    expect(() =>
      agent.clone({parentAgent: new LlmAgent({name: 'other'})}),
    ).toThrow('Cannot update `parentAgent` field in clone.');
  });
});
