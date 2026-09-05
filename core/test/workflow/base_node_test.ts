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
import type {NodeContext} from '../../src/workflow/node_context.js';
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

/** A class instance that states how it wants to be dumped. */
class Report {
  constructor(readonly title: string) {}
  toJSON(): {title: string} {
    return {title: this.title};
  }
}

const echo = (_ctx: NodeContext, input: unknown) => input;

describe('node name validation', () => {
  it.each(['ok_name', 'ok-name', '_leading', '__START__'])(
    'accepts %s',
    (name) => {
      expect(new FnNode(name, echo).name).toBe(name);
    },
  );

  it.each(['my node', '2fast', 'a.b', 'a@b'])('rejects %s', (name) => {
    expect(() => new FnNode(name, echo)).toThrow(
      `Found invalid node name: "${name}"`,
    );
  });

  it('rejects an empty or blank name', () => {
    expect(() => new FnNode('', echo)).toThrow(
      'Node name must be a non-empty string.',
    );
    expect(() => new FnNode('   ', echo)).toThrow(
      'Node name must be a non-empty string.',
    );
  });

  it('trims a padded name', () => {
    expect(new FnNode('  padded  ', echo).name).toBe('padded');
  });

  it('rejects a bad name given to node(), which skips the constructor', () => {
    const existing = new FnNode('ok', echo);
    expect(() => node(existing, {name: 'bad name'})).toThrow(
      'Found invalid node name: "bad name"',
    );
    expect(() => node(existing, {name: '  '})).toThrow(
      'Node name must be a non-empty string.',
    );
    expect(node(existing, {name: '  spaced  '}).name).toBe('spaced');
  });

  it('accepts the START sentinel name', () => {
    expect(START.name).toBe('__START__');
  });
});

describe('findStaticNodePath child discovery', () => {
  /** A node keeping its children in whatever container the test hands it. */
  class Holder extends FnNode {
    constructor(
      name: string,
      readonly held: unknown,
    ) {
      super(name, echo);
    }
  }

  /** A non-node class instance, standing in for a `Graph`. */
  class Opaque {
    constructor(readonly inner: BaseNode) {}
  }

  it('finds a child held in an array, a Set, a Map or a plain object', () => {
    const inArray = new FnNode('in-array', echo);
    const inSet = new FnNode('in-set', echo);
    const inMap = new FnNode('in-map', echo);
    const inObject = new FnNode('in-object', echo);

    expect(findStaticNodePath(new Holder('r', [inArray]), inArray)).toBe(
      'r.in-array',
    );
    expect(findStaticNodePath(new Holder('r', new Set([inSet])), inSet)).toBe(
      'r.in-set',
    );
    expect(
      findStaticNodePath(new Holder('r', new Map([['k', inMap]])), inMap),
    ).toBe('r.in-map');
    expect(findStaticNodePath(new Holder('r', {k: inObject}), inObject)).toBe(
      'r.in-object',
    );
  });

  it('finds a child held directly on a property', () => {
    const child = new FnNode('child', echo);
    expect(findStaticNodePath(new Holder('r', child), child)).toBe('r.child');
  });

  it('does not walk into a class instance that is not a node', () => {
    const hidden = new FnNode('hidden', echo);
    const root = new Holder('r', new Opaque(hidden));
    expect(findStaticNodePath(root, hidden)).toBeUndefined();
  });
});

describe('toSerializable', () => {
  it('passes a plain object, an array and a primitive through by value', () => {
    expect(toSerializable({a: 1, b: 'x'})).toEqual({a: 1, b: 'x'});
    expect(toSerializable([1, 'x', true])).toEqual([1, 'x', true]);
    expect(toSerializable('plain')).toBe('plain');
    expect(toSerializable(null)).toBeNull();
    expect(toSerializable(undefined)).toBeUndefined();
  });

  it('recurses into a nested array of objects', () => {
    expect(toSerializable({rows: [{a: [{b: 1}]}]})).toEqual({
      rows: [{a: [{b: 1}]}],
    });
  });

  // toStrictEqual, not toEqual: toEqual ignores the prototype, so an undumped
  // Report still matches a plain {title} object.
  it('dumps an object exposing toJSON()', () => {
    expect(toSerializable(new Report('top'))).toStrictEqual({title: 'top'});
  });

  it('dumps a toJSON() object nested in an array and in a plain object', () => {
    expect(toSerializable([new Report('a'), new Report('b')])).toStrictEqual([
      {title: 'a'},
      {title: 'b'},
    ]);
    expect(toSerializable({latest: new Report('c')})).toStrictEqual({
      latest: {title: 'c'},
    });
  });

  it('recurses into what toJSON() returns', () => {
    const wrapper = {toJSON: () => ({inner: new Report('deep')})};
    expect(toSerializable(wrapper)).toStrictEqual({inner: {title: 'deep'}});
  });

  it('returns a Map and a Set as they are', () => {
    const map = new Map([['k', 1]]);
    const set = new Set([1, 2]);
    expect(toSerializable(map)).toBe(map);
    expect(toSerializable(set)).toBe(set);
  });

  it('dumps a Date, which declares its own toJSON()', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    expect(toSerializable(date)).toBe('2026-01-02T03:04:05.000Z');
  });

  it('does not mutate its input', () => {
    const nested = {n: 1};
    const input = {nested, list: [nested]};
    const result = toSerializable(input) as {nested: unknown; list: unknown[]};

    expect(input.nested).toBe(nested);
    expect(input.list[0]).toBe(nested);
    expect(result).not.toBe(input);
    expect(result.nested).not.toBe(nested);
    expect(result).toEqual({nested: {n: 1}, list: [{n: 1}]});
  });
});

describe('validateOutput flattening', () => {
  const reportSchema = z
    .object({title: z.string()})
    .transform((v) => new Report(v.title));

  it('flattens a schema-produced class instance into plain data', async () => {
    const reporter = new FnNode('reporter', () => ({title: 'hi'}), {
      outputSchema: reportSchema,
    });

    const {events, output} = await driveNode(reporter);

    expect(output).toEqual({title: 'hi'});
    expect(output).not.toBeInstanceOf(Report);
    expect(events.at(-1)?.output).toEqual({title: 'hi'});
    expect(events.at(-1)?.output).not.toBeInstanceOf(Report);
  });

  it('flattens a schema-produced class instance on the input side', async () => {
    const reporter = new FnNode('reader', echo, {inputSchema: reportSchema});

    const {output} = await driveNode(reporter, {title: 'in'});

    expect(output).toEqual({title: 'in'});
    expect(output).not.toBeInstanceOf(Report);
  });

  it('leaves output alone when the node declares no schema', async () => {
    const report = new Report('untouched');
    const raw = new FnNode('raw', () => report);

    expect((await driveNode(raw)).output).toBe(report);
  });
});
