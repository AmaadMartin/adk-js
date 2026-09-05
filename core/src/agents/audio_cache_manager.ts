/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';

import {createEvent, Event} from '../events/event.js';
import {logger} from '../utils/logger.js';
import {
  InvocationContext,
  RealtimeCacheEntry,
  requireAgent,
} from './invocation_context.js';

/** Number of milliseconds in a second. */
const MILLISECONDS_PER_SECOND = 1000;

/** MIME type used when a cached audio chunk does not declare one. */
const DEFAULT_AUDIO_MIME_TYPE = 'audio/pcm';

/** Which realtime cache a chunk belongs to. */
export type AudioCacheType = 'input' | 'output';

/** Identifies a flushed cache in the artifact filename. */
type AudioCacheArtifactType = 'input_audio' | 'output_audio';

/** Which caches {@link AudioCacheManager.flushCaches} flushes. */
export interface FlushCachesOptions {
  /**
   * Whether to flush the input (user) audio cache. Defaults to `true`. The
   * model's audio is always flushed: an interruption ends the model's turn
   * while the user keeps speaking, and a completed turn ends both.
   */
  flushUserAudio?: boolean;
}

/**
 * Caches a live session's audio and flushes it to the artifact service.
 *
 * The user's audio and the model's audio are cached separately as the session
 * runs. A control event ends the turn and flushes each cache: its chunks are
 * joined into one artifact, and the returned {@link Event} carries a
 * `fileData` reference to it for the session.
 */
export class AudioCacheManager {
  /**
   * Caches one audio chunk.
   *
   * @param invocationContext The current invocation context.
   * @param audioBlob The audio chunk.
   * @param cacheType Whether the chunk is the user's audio (`'input'`) or the
   *     model's (`'output'`).
   * @throws {Error} If the blob carries no data.
   */
  cacheAudio(
    invocationContext: InvocationContext,
    audioBlob: Blob,
    cacheType: AudioCacheType,
  ): void {
    if (audioBlob.data === undefined) {
      throw new Error('Audio blobs must contain byte data.');
    }

    let cache: RealtimeCacheEntry[];
    if (cacheType === 'input') {
      cache = invocationContext.inputRealtimeCache ??= [];
    } else {
      cache = invocationContext.outputRealtimeCache ??= [];
    }

    cache.push({
      role: cacheType === 'input' ? 'user' : 'model',
      data: audioBlob,
      timestamp: Date.now() / MILLISECONDS_PER_SECOND,
    });

    logger.debug(
      `Cached ${cacheType} audio chunk; cache holds ${cache.length} chunk(s).`,
    );
  }

  /**
   * Flushes the audio caches to the artifact service.
   *
   * A cache is cleared only when its artifact was saved, so a failed save
   * keeps the audio for the next flush.
   *
   * @param invocationContext The invocation context holding the caches.
   * @param options Which caches to flush.
   * @return The events created from the flushed caches, user audio first.
   */
  async flushCaches(
    invocationContext: InvocationContext,
    options: FlushCachesOptions = {},
  ): Promise<Event[]> {
    const flushUserAudio = options.flushUserAudio ?? true;
    const flushedEvents: Event[] = [];

    if (flushUserAudio && invocationContext.inputRealtimeCache?.length) {
      const audioEvent = await this.flushCacheToServices(
        invocationContext,
        invocationContext.inputRealtimeCache,
        'input_audio',
      );
      if (audioEvent) {
        flushedEvents.push(audioEvent);
        invocationContext.inputRealtimeCache = [];
      }
    }

    if (invocationContext.outputRealtimeCache?.length) {
      const audioEvent = await this.flushCacheToServices(
        invocationContext,
        invocationContext.outputRealtimeCache,
        'output_audio',
      );
      if (audioEvent) {
        flushedEvents.push(audioEvent);
        invocationContext.outputRealtimeCache = [];
      }
    }

    return flushedEvents;
  }

  /**
   * Saves one non-empty cache as a single artifact and builds the session
   * event that references it.
   *
   * @return The created event, or `undefined` when there is no artifact
   *     service or the save failed. The caller keeps the cache in both cases.
   */
  private async flushCacheToServices(
    invocationContext: InvocationContext,
    cache: RealtimeCacheEntry[],
    cacheType: AudioCacheArtifactType,
  ): Promise<Event | undefined> {
    if (!invocationContext.artifactService) {
      logger.debug('Skipping audio cache flush: no artifact service.');
      return undefined;
    }

    const mimeType = cache[0].data.mimeType ?? DEFAULT_AUDIO_MIME_TYPE;
    // The filename records when the recording started, not when it was saved.
    const timestampMs = Math.floor(
      cache[0].timestamp * MILLISECONDS_PER_SECOND,
    );
    const filename = `adk_live_audio_storage_${cacheType}_${timestampMs}.${mimeType.split('/').pop()}`;

    let revisionId: number;
    try {
      revisionId = await invocationContext.artifactService.saveArtifact({
        filename,
        artifact: {inlineData: {data: concatAudioChunks(cache), mimeType}},
      });
    } catch (error: unknown) {
      logger.error(`Failed to flush the ${cacheType} cache:`, error);
      return undefined;
    }

    const role = cache[0].role;
    return createEvent({
      invocationId: invocationContext.invocationId,
      // A model event is authored by the agent rather than by the raw role.
      author: role === 'model' ? requireAgent(invocationContext).name : role,
      content: {
        role,
        parts: [
          {
            fileData: {
              fileUri: `artifact://${invocationContext.appName}/${invocationContext.userId}/${invocationContext.session.id}/_adk_live/${filename}#${revisionId}`,
              mimeType,
            },
          },
        ],
      },
      timestamp: cache[0].timestamp,
    });
  }
}

/**
 * Joins the base64-encoded chunks of a cache into one base64 string. Each
 * chunk is decoded to raw bytes first, so chunks of any length combine
 * correctly.
 */
function concatAudioChunks(cache: RealtimeCacheEntry[]): string {
  const buffers = cache.map((entry) =>
    Buffer.from(entry.data.data ?? '', 'base64'),
  );
  return Buffer.concat(buffers).toString('base64');
}
