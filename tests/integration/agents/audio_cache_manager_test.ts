/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AudioCacheManager,
  createSession,
  InMemoryArtifactService,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
// ScopedArtifactService is an internal adapter (not part of the public API),
// so it is imported directly to scope the in-memory service to a session.
import {ScopedArtifactService} from '../../../core/src/artifacts/scoped_artifact_service.js';

describe('AudioCacheManager integration', () => {
  it('aggregates cached audio into a loadable artifact and returns a file_data reference', async () => {
    const appName = 'integration-app';
    const userId = 'integration-user';
    const sessionId = 'integration-session';

    const backingService = new InMemoryArtifactService();
    const artifactService = new ScopedArtifactService(
      backingService,
      appName,
      userId,
      sessionId,
    );

    const ctx = new InvocationContext({
      invocationId: 'inv_integration',
      session: createSession({id: sessionId, appName, userId}),
      agent: new LlmAgent({name: 'integration_agent'}),
      pluginManager: new PluginManager(),
      artifactService,
    });

    const manager = new AudioCacheManager();
    const chunk1 = Buffer.from([0, 1, 2, 3]);
    const chunk2 = Buffer.from([4, 5, 6, 7, 8]);
    manager.cacheAudio(
      ctx,
      {data: chunk1.toString('base64'), mimeType: 'audio/pcm'},
      'input',
    );
    manager.cacheAudio(
      ctx,
      {data: chunk2.toString('base64'), mimeType: 'audio/pcm'},
      'input',
    );

    const events = await manager.flushCaches(ctx, {flushModelAudio: false});

    // The cache is drained and a single reference event is produced.
    expect(events).toHaveLength(1);
    expect(ctx.inputRealtimeCache).toEqual([]);

    // Parse "artifact://app/user/session/_adk_live/<filename>#<revision>".
    const fileUri = events[0].content?.parts?.[0].fileData?.fileUri;
    expect(fileUri).toBeDefined();
    const match = fileUri!.match(/_adk_live\/(.+)#(\d+)$/);
    expect(match).not.toBeNull();
    const filename = match![1];
    const revision = Number(match![2]);

    // The stored artifact decodes to the byte-exact concatenation of inputs.
    const stored = await artifactService.loadArtifact({
      filename,
      version: revision,
    });
    expect(stored?.inlineData?.data).toBeDefined();
    const decoded = Buffer.from(stored!.inlineData!.data!, 'base64');
    expect(decoded.equals(Buffer.concat([chunk1, chunk2]))).toBe(true);
    expect(stored?.inlineData?.mimeType).toBe('audio/pcm');
  });
});
