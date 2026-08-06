/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  UiWidget,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function createContext(): Context {
  const agent = new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'});
  const session = createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
  });

  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session,
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
  });
}

const widget1: UiWidget = {
  id: 'w1',
  provider: 'mcp',
  payload: {resource_uri: 'ui://app/one'},
};
const widget2: UiWidget = {
  id: 'w2',
  provider: 'mcp',
  payload: {resource_uri: 'ui://app/two'},
};

describe('Context.renderUiWidget', () => {
  it('appends the widget to the current event actions', () => {
    const context = createContext();

    context.renderUiWidget(widget1);

    expect(context.actions.renderUiWidgets).toHaveLength(1);
    expect(context.actions.renderUiWidgets?.[0]).toBe(widget1);
  });

  it('keeps multiple widgets in call order', () => {
    const context = createContext();

    context.renderUiWidget(widget1);
    context.renderUiWidget(widget2);

    expect(context.actions.renderUiWidgets).toEqual([widget1, widget2]);
  });

  it('rejects a duplicate widget id and leaves the list unchanged', () => {
    const context = createContext();
    context.renderUiWidget(widget1);

    expect(() =>
      context.renderUiWidget({
        id: 'w1',
        provider: 'custom',
        payload: {other: true},
      }),
    ).toThrowError(
      "UI widget with ID 'w1' already exists in the current event actions.",
    );
    expect(context.actions.renderUiWidgets).toEqual([widget1]);
  });
});
