/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LoadArtifactRequest,
  PluginManager,
  Runner,
  SaveFilesAsArtifactsPlugin,
} from '@google/adk';
import {ScopedArtifactService} from '@google/adk/artifacts/scoped_artifact_service.js';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'save_files_as_artifacts_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';
const PENDING_DELTA_KEY = 'save_files_as_artifacts_plugin:pending_delta';

/** Base64 for the ASCII bytes `report bytes`. */
const REPORT_BYTES = 'cmVwb3J0IGJ5dGVz';

/**
 * An in-memory artifact service that reports a `gs://` canonical URI, so the
 * plugin's file-reference path is exercised end to end. `InMemoryArtifactService`
 * itself reports no URI.
 */
class SimulatedGcsArtifactService extends InMemoryArtifactService {
  override async getArtifactVersion(request: LoadArtifactRequest) {
    const versionMeta = await super.getArtifactVersion(request);
    if (!versionMeta) {
      return undefined;
    }
    return {
      ...versionMeta,
      canonicalUri: `gs://simulated-bucket/${request.filename}/v${versionMeta.version}`,
    };
  }
}

/** An agent that answers without calling a model, so the run stays offline. */
class OfflineAgent extends LlmAgent {
  constructor() {
    super({name: 'offline_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Got the file.'}]},
    });
  }
}

async function runTurn(
  runner: Runner,
  sessionService: InMemorySessionService,
  message: Content,
) {
  for await (const _ of runner.runAsync({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: message,
  })) {
    // Consume the stream.
  }
  return sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
}

function uploadMessage(): Content {
  return {
    role: 'user',
    parts: [
      {text: 'Here is the report:'},
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: REPORT_BYTES,
          displayName: 'report.pdf',
        },
      },
    ],
  };
}

async function startRun(artifactService: InMemoryArtifactService) {
  const sessionService = new InMemorySessionService();
  const plugin = new SaveFilesAsArtifactsPlugin();
  const agent = new OfflineAgent();
  const runner = new Runner({
    appName: APP_NAME,
    agent,
    sessionService,
    artifactService,
    plugins: [plugin],
  });
  await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  return {sessionService, plugin, agent, runner};
}

describe('Integration: SaveFilesAsArtifactsPlugin', () => {
  it('stores the uploaded bytes and keeps them out of the session history', async () => {
    const artifactService = new InMemoryArtifactService();
    const {sessionService, runner} = await startRun(artifactService);

    const session = await runTurn(runner, sessionService, uploadMessage());

    const stored = await artifactService.loadArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      filename: 'report.pdf',
    });
    expect(stored?.inlineData?.data).toBe(REPORT_BYTES);

    const userEvent = session!.events.find((e) => e.author === 'user');
    expect(userEvent!.content!.parts).toEqual([
      {text: 'Here is the report:'},
      {text: '[Uploaded Artifact: "report.pdf"]'},
    ]);
    expect(JSON.stringify(session!.events)).not.toContain(REPORT_BYTES);
  });

  it('attaches a model-readable file reference when the artifact has a gs:// URI', async () => {
    const artifactService = new SimulatedGcsArtifactService();
    const {sessionService, runner} = await startRun(artifactService);

    const session = await runTurn(runner, sessionService, uploadMessage());

    const userEvent = session!.events.find((e) => e.author === 'user');
    expect(userEvent!.content!.parts?.[2]).toEqual({
      fileData: {
        fileUri: 'gs://simulated-bucket/report.pdf/v0',
        mimeType: 'application/pdf',
        displayName: 'report.pdf',
      },
    });
  });

  it('reports the saved version on the agent event actions', async () => {
    // adk-js's BaseAgent does not run plugin agent callbacks yet, so both hooks
    // are driven through the PluginManager over one invocation context, the way
    // the runner drives `onUserMessageCallback`. See the PR description.
    const artifactService = new InMemoryArtifactService();
    const sessionService = new InMemorySessionService();
    const plugin = new SaveFilesAsArtifactsPlugin();
    const pluginManager = new PluginManager([plugin]);
    const agent = new OfflineAgent();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const invocationContext = new InvocationContext({
      artifactService: new ScopedArtifactService(
        artifactService,
        APP_NAME,
        USER_ID,
        SESSION_ID,
      ),
      invocationId: 'reporting_invocation',
      agent,
      session,
      pluginManager,
    });

    await pluginManager.runOnUserMessageCallback({
      invocationContext,
      userMessage: uploadMessage(),
    });
    expect(session.state[PENDING_DELTA_KEY]).toEqual({'report.pdf': 0});

    const callbackContext = new Context({invocationContext});
    await pluginManager.runBeforeAgentCallback({agent, callbackContext});

    expect(callbackContext.actions.artifactDelta).toEqual({'report.pdf': 0});
    expect(session.state[PENDING_DELTA_KEY]).toEqual({});

    const stored = await artifactService.loadArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      filename: 'report.pdf',
    });
    expect(stored?.inlineData?.data).toBe(REPORT_BYTES);
  });
});
