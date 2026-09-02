/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createEventActions,
  createSession,
  InvocationContext,
  PluginManager,
  UiWidget,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'i-1',
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager(),
  });
}

function makeWidget(id: string): UiWidget {
  return {id, provider: 'mcp', payload: {resource_uri: 'ui://demo/card'}};
}

function createContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'app',
        userId: 'user',
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

const widget: UiWidget = {
  id: 'call-1',
  provider: 'mcp',
  payload: {resource_uri: 'ui://demo'},
};

describe('Context.renderUiWidget', () => {
  it('initialises the list and appends the widget', () => {
    const context = new Context({
      invocationContext: makeInvocationContext(),
    });
    expect(context.actions.renderUiWidgets).toBeUndefined();

    context.renderUiWidget(makeWidget('call-1'));

    expect(context.actions.renderUiWidgets).toEqual([makeWidget('call-1')]);
  });

  it('appends a second widget with a different id', () => {
    const context = new Context({
      invocationContext: makeInvocationContext(),
    });

    context.renderUiWidget(makeWidget('call-1'));
    context.renderUiWidget(makeWidget('call-2'));

    expect(context.actions.renderUiWidgets?.map((each) => each.id)).toEqual([
      'call-1',
      'call-2',
    ]);
  });

  it('throws on a duplicate widget id', () => {
    const context = new Context({
      invocationContext: makeInvocationContext(),
    });
    context.renderUiWidget(makeWidget('call-1'));

    expect(() => context.renderUiWidget(makeWidget('call-1'))).toThrow(
      "UI widget with ID 'call-1' already exists",
    );
    expect(context.actions.renderUiWidgets).toHaveLength(1);
  });

  it('attaches the first widget to the event actions', () => {
    const context = createContext();

    context.renderUiWidget(widget);

    expect(context.actions.renderUiWidgets).toEqual([widget]);
  });

  it('appends a widget with a different id', () => {
    const context = createContext();
    const other: UiWidget = {id: 'call-2', provider: 'mcp', payload: {}};

    context.renderUiWidget(widget);
    context.renderUiWidget(other);

    expect(context.actions.renderUiWidgets).toEqual([widget, other]);
  });

  it('refuses a widget whose id is already attached', () => {
    const context = createContext();
    context.renderUiWidget(widget);

    expect(() =>
      context.renderUiWidget({...widget, provider: 'other'}),
    ).toThrow(
      "UI widget with ID 'call-1' already exists in the current event actions.",
    );
    expect(context.actions.renderUiWidgets).toHaveLength(1);
  });
});

function uiWidget(id: string): UiWidget {
  return {id, provider: 'mcp', payload: {resource_uri: `ui://${id}`}};
}

describe('Context.renderUiWidget', () => {
  it('appends to a previously empty actions object', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    context.renderUiWidget(uiWidget('a'));

    expect(context.actions.renderUiWidgets).toEqual([uiWidget('a')]);
  });

  it('keeps both widgets when the ids differ, in order', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    context.renderUiWidget(uiWidget('a'));
    context.renderUiWidget(uiWidget('b'));

    expect(context.actions.renderUiWidgets?.map((w) => w.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('throws on a duplicate id and names it', () => {
    const context = new Context({invocationContext: makeInvocationContext()});
    context.renderUiWidget(uiWidget('dup-id'));

    expect(() => context.renderUiWidget(uiWidget('dup-id'))).toThrow(
      "UI widget with ID 'dup-id' already exists in the current event actions.",
    );
  });

  it('leaves the first widget in place when the duplicate is rejected', () => {
    const context = new Context({invocationContext: makeInvocationContext()});
    const first = uiWidget('dup-id');
    context.renderUiWidget(first);

    expect(() => context.renderUiWidget(uiWidget('dup-id'))).toThrow();

    expect(context.actions.renderUiWidgets).toEqual([first]);
  });

  it('writes onto the caller-supplied event actions', () => {
    const eventActions = createEventActions();
    const context = new Context({
      invocationContext: makeInvocationContext(),
      eventActions,
    });

    context.renderUiWidget(uiWidget('a'));

    expect(eventActions.renderUiWidgets).toEqual([uiWidget('a')]);
  });
});

describe('Context.customMetadata', () => {
  it('is the invocation-scoped store', () => {
    const invocationContext = makeInvocationContext();
    const context = new Context({invocationContext});

    context.customMetadata['http_debug_info'] = ['exchange'];

    expect(invocationContext.customMetadata).toEqual({
      http_debug_info: ['exchange'],
    });
  });

  it('starts empty', () => {
    const context = new Context({
      invocationContext: makeInvocationContext(),
    });

    expect(context.customMetadata).toEqual({});
  });

  it('is shared with a context built from a clone of the invocation', () => {
    const invocationContext = makeInvocationContext();
    const context = new Context({invocationContext});
    context.customMetadata['seen'] = true;

    const cloned = new Context({
      invocationContext: invocationContext.clone({branch: 'child'}),
    });

    expect(cloned.customMetadata).toEqual({seen: true});
    cloned.customMetadata['also'] = 1;
    expect(context.customMetadata).toEqual({seen: true, also: 1});
  });

  it('exposes the invocation bag and writes through to it', () => {
    const context = createContext();

    context.customMetadata['key'] = 'value';

    expect(context.invocationContext.customMetadata).toEqual({key: 'value'});
  });

  it('reads back what the invocation already carries', () => {
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'app',
        userId: 'user',
      }),
      pluginManager: new PluginManager(),
      customMetadata: {existing: 1},
    });

    expect(new Context({invocationContext}).customMetadata).toEqual({
      existing: 1,
    });
  });
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
