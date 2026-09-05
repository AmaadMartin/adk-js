/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  BaseNode,
  findStaticNodePath,
  isBaseNode,
  isContent,
  START,
  toContent,
  toSerializable,
} from '../../src/workflow/base_node.js';
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

/** A node holding one arbitrary value, to exercise child discovery. */
class ContainerNode extends BaseNode {
  constructor(
    name: string,
    readonly held: unknown,
  ) {
    super({name});
  }

  protected runImpl(): AsyncGenerator<never, void, void> {
    throw new Error('not executed');
  }
}

describe('findStaticNodePath', () => {
  const leaf = () => new FnNode('leaf', (_c, i) => i);

  it('finds a child held directly on a property', () => {
    const child = leaf();
    expect(findStaticNodePath(new ContainerNode('root', child), child)).toBe(
      'root.leaf',
    );
  });

  it('finds a child held in an array, a Set, a Map or a plain object', () => {
    for (const wrap of [
      (n: BaseNode) => [n],
      (n: BaseNode) => new Set([n]),
      (n: BaseNode) => new Map([['a', n]]),
      (n: BaseNode) => ({a: n}),
    ]) {
      const child = leaf();
      const root = new ContainerNode('root', wrap(child));
      expect(findStaticNodePath(root, child)).toBe('root.leaf');
    }
  });

  it('does not find a node nested two containers deep', () => {
    const child = leaf();
    const root = new ContainerNode('root', [[child]]);
    expect(findStaticNodePath(root, child)).toBeUndefined();
  });
});

describe('toSerializable', () => {
  it('returns a primitive, a function and null unchanged', () => {
    const fn = () => 'x';
    expect(toSerializable(1)).toBe(1);
    expect(toSerializable('x')).toBe('x');
    expect(toSerializable(null)).toBeNull();
    expect(toSerializable(undefined)).toBeUndefined();
    expect(toSerializable(fn)).toBe(fn);
  });

  it('returns an already-plain object and array by identity', () => {
    const plain = {a: 1, nested: {b: [1, 2]}};
    expect(toSerializable(plain)).toBe(plain);
    const list = [1, {a: 2}];
    expect(toSerializable(list)).toBe(list);
  });

  it('turns a Set into an array', () => {
    expect(toSerializable(new Set([1, 2]))).toEqual([1, 2]);
    expect(toSerializable(new Set([new Set([1])]))).toEqual([[1]]);
  });

  it('turns a Map into a plain object, stringifying its keys', () => {
    expect(toSerializable(new Map([['a', 1]]))).toEqual({a: 1});
    expect(toSerializable(new Map([[1, new Set(['x'])]]))).toEqual({
      '1': ['x'],
    });
  });

  it('dumps a value through toJSON', () => {
    const when = new Date('2026-01-02T03:04:05.000Z');
    expect(toSerializable(when)).toBe('2026-01-02T03:04:05.000Z');
    expect(toSerializable({when})).toEqual({when: '2026-01-02T03:04:05.000Z'});
  });

  it('turns a class instance into a plain object', () => {
    class Point {
      constructor(
        readonly x = 1,
        readonly y = 2,
      ) {}
    }
    const flat = toSerializable(new Point());
    expect(flat).toEqual({x: 1, y: 2});
    expect(Object.getPrototypeOf(flat)).toBe(Object.prototype);

    class Bag {
      constructor(readonly tags = new Set(['a'])) {}
    }
    expect(toSerializable(new Bag())).toEqual({tags: ['a']});
  });

  it('converts a value nested inside a plain container', () => {
    expect(toSerializable({tags: new Set(['a'])})).toEqual({tags: ['a']});
    expect(toSerializable([new Set(['a'])])).toEqual([['a']]);
  });

  it('terminates on a circular structure', () => {
    const circular: Record<string, unknown> = {name: 'x'};
    circular.self = circular;
    expect(toSerializable(circular)).toBe(circular);
  });

  it('hands the original back where a cycle closes', () => {
    const circular: Record<string, unknown> = {tags: new Set([1])};
    circular.self = circular;
    const flat = toSerializable(circular) as Record<string, unknown>;
    expect(flat).not.toBe(circular);
    expect(flat.tags).toEqual([1]);
    expect(flat.self).toBe(circular);
  });

  it('returns the original when toJSON throws', () => {
    const broken = {
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(toSerializable(broken)).toBe(broken);
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
});
