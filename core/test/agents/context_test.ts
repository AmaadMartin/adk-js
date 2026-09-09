/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  PluginManager,
  UiWidget,
  createEventActions,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager(),
  });
}

function widget(id: string): UiWidget {
  return {id, provider: 'mcp', payload: {resource_uri: `ui://${id}`}};
}

describe('Context.renderUiWidget', () => {
  it('appends to a previously empty actions object', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    context.renderUiWidget(widget('a'));

    expect(context.actions.renderUiWidgets).toEqual([widget('a')]);
  });

  it('keeps both widgets when the ids differ, in order', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    context.renderUiWidget(widget('a'));
    context.renderUiWidget(widget('b'));

    expect(context.actions.renderUiWidgets?.map((w) => w.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('throws on a duplicate id and names it', () => {
    const context = new Context({invocationContext: makeInvocationContext()});
    context.renderUiWidget(widget('dup-id'));

    expect(() => context.renderUiWidget(widget('dup-id'))).toThrow(
      "UI widget with ID 'dup-id' already exists in the current event actions.",
    );
  });

  it('leaves the first widget in place when the duplicate is rejected', () => {
    const context = new Context({invocationContext: makeInvocationContext()});
    const first = widget('dup-id');
    context.renderUiWidget(first);

    expect(() => context.renderUiWidget(widget('dup-id'))).toThrow();

    expect(context.actions.renderUiWidgets).toEqual([first]);
  });

  it('writes onto the caller-supplied event actions', () => {
    const eventActions = createEventActions();
    const context = new Context({
      invocationContext: makeInvocationContext(),
      eventActions,
    });

    context.renderUiWidget(widget('a'));

    expect(eventActions.renderUiWidgets).toEqual([widget('a')]);
  });
});

describe('Context.customMetadata', () => {
  it('is the same object across two contexts on one invocation', () => {
    const invocationContext = makeInvocationContext();
    const first = new Context({invocationContext});
    const second = new Context({invocationContext});

    expect(first.customMetadata).toBe(second.customMetadata);
  });

  it('survives a write and is visible from a sibling context', () => {
    const invocationContext = makeInvocationContext();
    const first = new Context({invocationContext});
    const second = new Context({invocationContext});

    first.customMetadata['http_debug_info'] = [{status: 200}];

    expect(second.customMetadata['http_debug_info']).toEqual([{status: 200}]);
  });

  it('starts empty', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(context.customMetadata).toEqual({});
  });
});
