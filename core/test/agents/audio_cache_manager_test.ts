/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AudioCacheManager,
  AudioCacheType,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SessionArtifactService,
  SessionSaveArtifactRequest,
  createSession,
} from '@google/adk';
import {Blob} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';

/**
 * Builds a fake {@link SessionArtifactService} whose `saveArtifact` is a spy so
 * tests can assert call counts and arguments (mirrors the Python AsyncMock).
 */
function createArtifactServiceSpy(
  saveImpl: (
    request: SessionSaveArtifactRequest,
  ) => Promise<number> = async () => 0,
) {
  const saveArtifact = vi.fn(saveImpl);
  const service = {
    saveArtifact,
    loadArtifact: vi.fn(),
    listArtifactKeys: vi.fn(),
    deleteArtifact: vi.fn(),
    listVersions: vi.fn(),
    listArtifactVersions: vi.fn(),
    getArtifactVersion: vi.fn(),
  } as unknown as SessionArtifactService;
  return {service, saveArtifact};
}

function createContext(
  options: {agentName?: string; artifactService?: SessionArtifactService} = {},
): InvocationContext {
  const agent = new LlmAgent({name: options.agentName ?? 'test_agent'});
  const session = createSession({
    id: SESSION_ID,
    appName: APP_NAME,
    userId: USER_ID,
  });
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session,
    pluginManager: new PluginManager(),
    artifactService: options.artifactService,
  });
}

function blob(text: string, mimeType = 'audio/pcm'): Blob {
  return {data: Buffer.from(text).toString('base64'), mimeType};
}

describe('AudioCacheManager', () => {
  describe('cacheAudio', () => {
    it('caches input audio under the user role', () => {
      const manager = new AudioCacheManager();
      const context = createContext();
      const audioBlob = blob('test_audio_data');

      expect(context.inputRealtimeCache).toBeUndefined();

      manager.cacheAudio(context, audioBlob, 'input');

      expect(context.inputRealtimeCache).toHaveLength(1);
      const entry = context.inputRealtimeCache![0];
      expect(entry.role).toBe('user');
      expect(entry.data).toBe(audioBlob);
      expect(typeof entry.timestamp).toBe('number');
    });

    it('caches output audio under the model role', () => {
      const manager = new AudioCacheManager();
      const context = createContext();
      const audioBlob = blob('test_model_audio', 'audio/wav');

      expect(context.outputRealtimeCache).toBeUndefined();

      manager.cacheAudio(context, audioBlob, 'output');

      expect(context.outputRealtimeCache).toHaveLength(1);
      const entry = context.outputRealtimeCache![0];
      expect(entry.role).toBe('model');
      expect(entry.data).toBe(audioBlob);
      expect(typeof entry.timestamp).toBe('number');
    });

    it('accumulates multiple chunks', () => {
      const manager = new AudioCacheManager();
      const context = createContext();

      for (let i = 0; i < 3; i++) {
        manager.cacheAudio(context, blob(`input_${i}`), 'input');
      }
      for (let i = 0; i < 2; i++) {
        manager.cacheAudio(context, blob(`output_${i}`, 'audio/wav'), 'output');
      }

      expect(context.inputRealtimeCache).toHaveLength(3);
      expect(context.outputRealtimeCache).toHaveLength(2);
    });

    it('throws for an invalid cache type', () => {
      const manager = new AudioCacheManager();
      const context = createContext();

      expect(() =>
        manager.cacheAudio(context, blob('x'), 'invalid' as AudioCacheType),
      ).toThrowError("cacheType must be either 'input' or 'output'");
    });
  });

  describe('flushCaches', () => {
    it('flushes both caches and clears them', async () => {
      const manager = new AudioCacheManager();
      const {service, saveArtifact} = createArtifactServiceSpy(async () => 123);
      const context = createContext({artifactService: service});

      manager.cacheAudio(context, blob('input_data'), 'input');
      manager.cacheAudio(context, blob('output_data', 'audio/wav'), 'output');

      await manager.flushCaches(context);

      expect(context.inputRealtimeCache).toEqual([]);
      expect(context.outputRealtimeCache).toEqual([]);
      expect(saveArtifact).toHaveBeenCalledTimes(2);
    });

    it('selectively flushes only the requested cache', async () => {
      const manager = new AudioCacheManager();
      const {service, saveArtifact} = createArtifactServiceSpy(async () => 123);
      const context = createContext({artifactService: service});

      manager.cacheAudio(context, blob('input_data'), 'input');
      manager.cacheAudio(context, blob('output_data', 'audio/wav'), 'output');

      await manager.flushCaches(context, {
        flushUserAudio: true,
        flushModelAudio: false,
      });

      expect(context.inputRealtimeCache).toEqual([]);
      expect(context.outputRealtimeCache).toHaveLength(1);
      expect(saveArtifact).toHaveBeenCalledTimes(1);
    });

    it('does not call the artifact service when caches are empty', async () => {
      const manager = new AudioCacheManager();
      const {service, saveArtifact} = createArtifactServiceSpy();
      const context = createContext({artifactService: service});

      await manager.flushCaches(context);

      expect(saveArtifact).not.toHaveBeenCalled();
    });

    it('retains the cache when no artifact service is configured', async () => {
      const manager = new AudioCacheManager();
      const context = createContext();

      manager.cacheAudio(context, blob('input_data'), 'input');

      await expect(manager.flushCaches(context)).resolves.toEqual([]);

      expect(context.inputRealtimeCache).toHaveLength(1);
    });

    it('saves the combined audio artifact with the correct data and mime type', async () => {
      const manager = new AudioCacheManager();
      const {service, saveArtifact} = createArtifactServiceSpy(async () => 456);
      const context = createContext({artifactService: service});

      const data = Buffer.from('specific_test_audio_data').toString('base64');
      manager.cacheAudio(context, {data, mimeType: 'audio/pcm'}, 'input');

      await manager.flushCaches(context);

      expect(saveArtifact).toHaveBeenCalledOnce();
      const savedArtifact = saveArtifact.mock.calls[0][0].artifact;
      expect(savedArtifact.inlineData?.data).toBe(data);
      expect(savedArtifact.inlineData?.mimeType).toBe('audio/pcm');
    });

    it('combines multiple chunks into a single artifact by raw bytes', async () => {
      const manager = new AudioCacheManager();
      const {service, saveArtifact} = createArtifactServiceSpy(async () => 1);
      const context = createContext({artifactService: service});

      manager.cacheAudio(context, blob('first'), 'input');
      manager.cacheAudio(context, blob('second'), 'input');

      await manager.flushCaches(context);

      const savedArtifact = saveArtifact.mock.calls[0][0].artifact;
      const expected = Buffer.from('firstsecond').toString('base64');
      expect(savedArtifact.inlineData?.data).toBe(expected);
    });

    it('uses the first chunk timestamp in the filename and artifact reference', async () => {
      const manager = new AudioCacheManager();
      const {service, saveArtifact} = createArtifactServiceSpy(async () => 789);
      const context = createContext({artifactService: service});

      const firstTimestamp = 1234567890.123;
      const secondTimestamp = 1234567891.456;
      context.inputRealtimeCache = [
        {role: 'user', data: blob('first_chunk'), timestamp: firstTimestamp},
        {role: 'user', data: blob('second_chunk'), timestamp: secondTimestamp},
      ];

      const [event] = await manager.flushCaches(context);

      const expectedMs = Math.floor(firstTimestamp * 1000);
      const filename = saveArtifact.mock.calls[0][0].filename;
      expect(filename).toBe(
        `adk_live_audio_storage_input_audio_${expectedMs}.pcm`,
      );
      expect(event.content?.parts?.[0].fileData?.fileUri).toBe(
        `artifact://${APP_NAME}/${USER_ID}/${SESSION_ID}/_adk_live/${filename}#789`,
      );
      expect(event.timestamp).toBe(firstTimestamp);
    });

    it('falls back to defaults for a chunk missing data and mime type', async () => {
      const manager = new AudioCacheManager();
      const {service, saveArtifact} = createArtifactServiceSpy(async () => 1);
      const context = createContext({artifactService: service});

      manager.cacheAudio(context, {}, 'input');

      await manager.flushCaches(context);

      const request = saveArtifact.mock.calls[0][0];
      expect(request.filename).toMatch(
        /^adk_live_audio_storage_input_audio_\d+\.pcm$/,
      );
      expect(request.artifact.inlineData?.data).toBe('');
      expect(request.artifact.inlineData?.mimeType).toBe('audio/pcm');
    });

    it('swallows save errors and retains the cache', async () => {
      const manager = new AudioCacheManager();
      const {service} = createArtifactServiceSpy(async () => {
        throw new Error('Artifact service error');
      });
      const context = createContext({artifactService: service});

      manager.cacheAudio(context, blob('test_data'), 'input');

      await expect(manager.flushCaches(context)).resolves.toEqual([]);

      expect(context.inputRealtimeCache).toHaveLength(1);
    });

    it('authors flushed user audio as the user', async () => {
      const manager = new AudioCacheManager();
      const {service} = createArtifactServiceSpy(async () => 123);
      const context = createContext({artifactService: service});

      manager.cacheAudio(context, blob('user_audio_data'), 'input');

      const events = await manager.flushCaches(context, {
        flushUserAudio: true,
        flushModelAudio: false,
      });

      expect(events).toHaveLength(1);
      expect(events[0].author).toBe('user');
      expect(events[0].content?.role).toBe('user');
    });

    it('authors flushed model audio as the agent, not the model role', async () => {
      const manager = new AudioCacheManager();
      const {service} = createArtifactServiceSpy(async () => 123);
      const context = createContext({
        agentName: 'my_test_agent',
        artifactService: service,
      });

      manager.cacheAudio(
        context,
        blob('model_audio_data', 'audio/wav'),
        'output',
      );

      const events = await manager.flushCaches(context, {
        flushUserAudio: false,
        flushModelAudio: true,
      });

      expect(events).toHaveLength(1);
      expect(events[0].author).toBe('my_test_agent');
      expect(events[0].content?.role).toBe('model');
    });
  });
});
