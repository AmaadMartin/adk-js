/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  Runner,
  SaveFilesAsArtifactsPlugin,
} from '@google/adk';
import {Blob, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

class SimpleEchoAgent extends BaseAgent {
  constructor() {
    super({name: 'echo_agent'});
  }

  protected async *runAsyncImpl(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: invocationContext.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Echo response'}]},
    });
  }
}

describe('SaveFilesAsArtifactsPlugin Integration Test', () => {
  it('should save inline Blobs to artifact service, replace with placeholder and fileData, and report artifactDelta', async () => {
    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();
    const plugin = new SaveFilesAsArtifactsPlugin();
    const agent = new SimpleEchoAgent();

    // Mock canonicalUri return from InMemoryArtifactService so fileData part is attached
    const origGetArtifactVersion =
      artifactService.getArtifactVersion.bind(artifactService);
    artifactService.getArtifactVersion = async (req) => {
      const versionObj = await origGetArtifactVersion(req);
      if (versionObj) {
        versionObj.canonicalUri = `gs://mock-bucket/${req.filename}/versions/${versionObj.version}`;
      }
      return versionObj;
    };

    const runner = new Runner({
      appName: 'integration_test_app',
      agent,
      sessionService,
      artifactService,
      plugins: [plugin],
    });

    const session = await sessionService.createSession({
      appName: 'integration_test_app',
      userId: 'test_user',
    });

    const inlineData: Blob = {
      displayName: 'sample_image.png',
      data: 'aW1hZ2VfYnl0ZXM=',
      mimeType: 'image/png',
    };

    const inputPart: Part = {inlineData};

    const yieldedEvents: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [inputPart]},
    })) {
      yieldedEvents.push(event);
    }

    // 1. Verify artifact was saved to storage
    const keys = await artifactService.listArtifactKeys({
      appName: 'integration_test_app',
      userId: 'test_user',
      sessionId: session.id,
    });
    expect(keys).toContain('sample_image.png');

    const savedPart = await artifactService.loadArtifact({
      appName: 'integration_test_app',
      userId: 'test_user',
      sessionId: session.id,
      filename: 'sample_image.png',
    });
    expect(savedPart).toBeDefined();
    expect(savedPart!.inlineData).toEqual(inlineData);

    // 2. Verify session event log contains the placeholder text and fileData part
    const updatedSession = await sessionService.getSession({
      appName: 'integration_test_app',
      userId: 'test_user',
      sessionId: session.id,
    });
    expect(updatedSession).toBeDefined();
    const userEvent = updatedSession!.events.find((e) => e.author === 'user');
    expect(userEvent).toBeDefined();
    expect(userEvent!.content?.parts).toBeDefined();
    expect(userEvent!.content!.parts![0].text).toBe(
      '[Uploaded Artifact: "sample_image.png"]',
    );
    expect(userEvent!.content!.parts![1].fileData).toBeDefined();
    expect(userEvent!.content!.parts![1].fileData!.fileUri).toBe(
      'gs://mock-bucket/sample_image.png/versions/0',
    );

    // 3. Verify actions.artifactDelta is reported in one of the yielded events
    const deltaEvent = yieldedEvents.find(
      (e) =>
        e.actions &&
        e.actions.artifactDelta &&
        e.actions.artifactDelta['sample_image.png'] === 0,
    );
    expect(deltaEvent).toBeDefined();
  });
});
