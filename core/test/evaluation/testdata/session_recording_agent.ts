/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, BasePlugin, InvocationContext, LlmAgent} from '@google/adk';
import {Content} from '@google/genai';

import {ScriptedLlm} from '../test_helpers.js';

/** The session each eval run of this module ran in, in run order. */
export const recordedSessions: Array<{
  appName: string;
  userId: string;
  sessionId: string;
}> = [];

/** Reports the session a run used, so a test can check what reached it. */
class SessionRecordingPlugin extends BasePlugin {
  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    const {session} = params.invocationContext;
    recordedSessions.push({
      appName: session.appName,
      userId: session.userId,
      sessionId: session.id,
    });
    return;
  }
}

const rootAgent = new LlmAgent({
  name: 'session_fixture_agent',
  model: new ScriptedLlm(['from the session fixture']),
});

export const agent = {
  app: new App({
    name: 'session_fixture_app',
    rootAgent,
    plugins: [new SessionRecordingPlugin('session_recording_plugin')],
  }),
};
