/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  isBaseNode,
  isContent,
  START,
  toContent,
} from '../../src/workflow/base_node.js';
import {
  isNodeSchemaValidationError,
  NodeSchemaValidationError,
} from '../../src/workflow/errors.js';
import {node} from '../../src/workflow/node.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {isWorkflow, Workflow} from '../../src/workflow/workflow.js';
import {driveNode, FnNode} from './test_helpers.js';

describe('isBaseNode', () => {
  it('recognizes node instances and the START sentinel', () => {
    expect(isBaseNode(new FnNode('n', (_c, i) => i))).toBe(true);
    expect(isBaseNode(START)).toBe(true);
  });

  it('rejects non-nodes', () => {
    expect(isBaseNode({})).toBe(false);
    expect(isBaseNode(null)).toBe(false);
    expect(isBaseNode('START')).toBe(false);
  });
});

describe('isWorkflow', () => {
  const workflow = new Workflow({
    name: 'wf',
    edges: [['START', node(() => 'x', {name: 'step'})]],
  });

  it('recognizes a Workflow', () => {
    expect(isWorkflow(workflow)).toBe(true);
    // The brand is an instance field, so it survives the `@experimental`
    // decorator wrapping the class.
    expect(isBaseNode(workflow)).toBe(true);
  });

  it('rejects other nodes and non-nodes', () => {
    expect(isWorkflow(new FnNode('n', (_c, i) => i))).toBe(false);
    expect(isWorkflow(START)).toBe(false);
    expect(isWorkflow({})).toBe(false);
    expect(isWorkflow(null)).toBe(false);
  });
});

describe('isContent', () => {
  it('is true for objects with a parts array', () => {
    expect(isContent({parts: []})).toBe(true);
    expect(isContent({role: 'model', parts: [{text: 'x'}]})).toBe(true);
  });

  it('is false without a parts array', () => {
    expect(isContent({role: 'model'})).toBe(false);
    expect(isContent({parts: 'x'})).toBe(false);
    expect(isContent('x')).toBe(false);
    expect(isContent(null)).toBe(false);
  });
});

describe('toContent', () => {
  const text = (c: Content | undefined) => c?.parts?.[0]?.text;

  it('returns undefined for null / undefined', () => {
    expect(toContent(null)).toBeUndefined();
    expect(toContent(undefined)).toBeUndefined();
  });

  it('passes a Content value through unchanged', () => {
    const content: Content = {role: 'model', parts: [{text: 'hi'}]};
    expect(toContent(content)).toBe(content);
  });

  it('wraps a string into a text part', () => {
    expect(text(toContent('hello'))).toBe('hello');
  });

  it('wraps a Part and an array of Parts', () => {
    expect(text(toContent({text: 'p'}))).toBe('p');
    const many = toContent([{text: 'a'}, {text: 'b'}]);
    expect(many?.parts).toHaveLength(2);
  });

  it('serializes a plain object to JSON text', () => {
    expect(text(toContent({count: 1}))).toBe('{"count":1}');
  });

  it('serializes numbers and booleans to text', () => {
    expect(text(toContent(42))).toBe('42');
    expect(text(toContent(true))).toBe('true');
  });

  it('does not throw on a value JSON cannot serialize (circular ref)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toContent(circular)).not.toThrow();
    expect(typeof text(toContent(circular))).toBe('string');
  });
});

describe('BaseNode name validation', () => {
  const build = (name: string) => () => new FnNode(name, (_c, i) => i);

  it('accepts identifier-shaped names', () => {
    for (const name of [
      'snake_case',
      'camelCase',
      '_leading_underscore',
      'with-hyphen',
      'n1',
      START.name,
    ]) {
      expect(build(name)().name).toBe(name);
    }
  });

  it('constructs the START sentinel', () => {
    expect(START.name).toBe('__START__');
  });

  it('rejects a name that is not an identifier, naming the value', () => {
    for (const name of ['my node', '1abc', 'a.b', 'a/b']) {
      expect(build(name)).toThrow(
        `Found invalid node name: "${name}". Node name must be a valid identifier.`,
      );
    }
  });

  it('keeps the non-empty message for an empty or blank name', () => {
    expect(build('')).toThrow('Node name must be a non-empty string.');
    expect(build('   ')).toThrow('Node name must be a non-empty string.');
  });
});

describe('node output flattening', () => {
  it('leaves the output of a node without an outputSchema untouched', async () => {
    const output = {tags: new Set(['a'])};
    const {events} = await driveNode(new FunctionNode('plain', () => output));
    expect(events.at(-1)?.output).toBe(output);
  });

  it('flattens a Date the outputSchema produced', async () => {
    const node = new FunctionNode(
      'dated',
      () => ({when: '2026-01-02T03:04:05.000Z'}),
      {outputSchema: z.object({when: z.coerce.date()})},
    );
    const {events} = await driveNode(node);
    expect(events.at(-1)?.output).toEqual({
      when: '2026-01-02T03:04:05.000Z',
    });
  });

  it('flattens a class instance a transform produced', async () => {
    class Tags {
      constructor(readonly values: string[]) {}
    }
    const node = new FunctionNode('tagged', () => ['a', 'b'], {
      outputSchema: z.array(z.string()).transform((v) => new Tags(v)),
    });
    const {events} = await driveNode(node);
    expect(events.at(-1)?.output).toEqual({values: ['a', 'b']});
  });

  it('names the node when flattening a hostile output fails', async () => {
    const hostile = {
      get boom(): unknown {
        throw new Error('nope');
      },
    };
    const node = new FunctionNode('hostile', () => hostile, {
      outputSchema: z.any(),
    });
    try {
      await driveNode(node);
      expect.unreachable('expected a NodeSchemaValidationError');
    } catch (e) {
      expect(isNodeSchemaValidationError(e)).toBe(true);
      const err = e as NodeSchemaValidationError;
      expect(err.nodeName).toBe('hostile');
      expect(err.direction).toBe('output');
    }
  });
});
