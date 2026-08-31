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
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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

describe('Context.customMetadata', () => {
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

  it('creates the bag when the invocation has none', () => {
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'app',
        userId: 'user',
      }),
      pluginManager: new PluginManager(),
    });
    // A fixture built by casting an object literal — a widespread pattern in
    // this suite — genuinely has no `customMetadata` at runtime.
    Reflect.deleteProperty(invocationContext, 'customMetadata');
    const context = new Context({invocationContext});

    context.customMetadata['key'] = 'value';

    expect(invocationContext.customMetadata).toEqual({key: 'value'});
  });
});
