/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, Event, InvocationContext} from '@google/adk';

/**
 * Replaces the text of every event with its own name, so a test can prove
 * from the server's response that the runner ran this plugin.
 */
export class MarkingPlugin extends BasePlugin {
  override async onEventCallback(params: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    return {
      ...params.event,
      content: {role: 'model', parts: [{text: `marked by ${this.name}`}]},
    };
  }
}

/** A plugin exported as a ready-made instance rather than as a class. */
export const readyMadePlugin = new MarkingPlugin('ready_made');

/** An export that is neither a plugin class nor a plugin instance. */
export const notAPlugin = {name: 'impostor'};
