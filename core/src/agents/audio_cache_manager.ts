/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';

import {createEvent, Event} from '../events/event.js';
import {logger} from '../utils/logger.js';
import {InvocationContext, RealtimeCacheEntry} from './invocation_context.js';

/** Number of milliseconds in a second. */
const MILLISECONDS_PER_SECOND = 1000;

/** MIME type used when a cached audio chunk does not declare one. */
const DEFAULT_AUDIO_MIME_TYPE = 'audio/pcm';

/** Which realtime cache a chunk belongs to. */
export type AudioCacheType = 'input' | 'output';

/** Identifies a flushed cache in artifact filenames. */
type AudioCacheArtifactType = 'input_audio' | 'output_audio';

/**
 * Options controlling which caches {@link AudioCacheManager.flushCaches}
 * flushes. Both default to `true`.
 */
export interface FlushCachesOptions {
  /** Whether to flush the input (user) audio cache. Defaults to `true`. */
  flushUserAudio?: boolean;
  /** Whether to flush the output (model) audio cache. Defaults to `true`. */
  flushModelAudio?: boolean;
}

/**
 * Manages audio caching and flushing for live streaming flows.
 *
 * Incoming user audio and outgoing model audio are cached per invocation, then
 * flushed to the artifact service on control events (turn complete /
 * interruption). Each flushed cache is stored as a single audio artifact and
 * surfaced to the session as an {@link Event} that references it via `fileData`.
 */
export class AudioCacheManager {
  /**
   * Caches an incoming user or outgoing model audio chunk.
   *
   * @param invocationContext The current invocation context.
   * @param audioBlob The audio data to cache.
   * @param cacheType Whether the chunk is `'input'` (user) or `'output'`
   *     (model) audio.
   * @throws {Error} If `cacheType` is neither `'input'` nor `'output'`.
   */
  cacheAudio(
    invocationContext: InvocationContext,
    audioBlob: Blob,
    cacheType: AudioCacheType,
  ): void {
    let cache: RealtimeCacheEntry[];
    let role: string;
    if (cacheType === 'input') {
      invocationContext.inputRealtimeCache ??= [];
      cache = invocationContext.inputRealtimeCache;
      role = 'user';
    } else if (cacheType === 'output') {
      invocationContext.outputRealtimeCache ??= [];
      cache = invocationContext.outputRealtimeCache;
      role = 'model';
    } else {
      throw new Error("cacheType must be either 'input' or 'output'");
    }

    cache.push({
      role,
      data: audioBlob,
      timestamp: Date.now() / MILLISECONDS_PER_SECOND,
    });

    logger.debug(
      `Cached ${cacheType} audio chunk: ${
        audioBlob.data?.length ?? 0
      } bytes, cache size: ${cache.length}`,
    );
  }

  /**
   * Flushes audio caches to the artifact service.
   *
   * Each non-empty, enabled cache is stored as a single audio artifact and, on
   * success, cleared. The blob lives in the artifact service; the returned
   * {@link Event} carries a `fileData` reference for the session.
   *
   * @param invocationContext The invocation context holding the audio caches.
   * @param options Which caches to flush. Both default to `true`.
   * @returns The events created from the flushed caches, in input-then-output
   *     order.
   */
  async flushCaches(
    invocationContext: InvocationContext,
    options: FlushCachesOptions = {},
  ): Promise<Event[]> {
    const flushUserAudio = options.flushUserAudio ?? true;
    const flushModelAudio = options.flushModelAudio ?? true;
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

    if (flushModelAudio && invocationContext.outputRealtimeCache?.length) {
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
   * Combines a single (non-empty) cache's chunks into one artifact and builds
   * the session event that references it. Empty caches are filtered out by
   * {@link AudioCacheManager.flushCaches} before this is called.
   *
   * @returns The created event, or `undefined` when there is no artifact
   *     service or the save fails (the cache is retained in either no-op case).
   */
  private async flushCacheToServices(
    invocationContext: InvocationContext,
    cache: RealtimeCacheEntry[],
    cacheType: AudioCacheArtifactType,
  ): Promise<Event | undefined> {
    if (!invocationContext.artifactService) {
      logger.debug('Skipping cache flush: no artifact service');
      return undefined;
    }

    try {
      const mimeType = cache[0].data.mimeType ?? DEFAULT_AUDIO_MIME_TYPE;
      const combinedData = concatAudioChunks(cache);

      // The filename timestamp marks when recording started (the first chunk),
      // not flush time.
      const timestampMs = Math.floor(
        cache[0].timestamp * MILLISECONDS_PER_SECOND,
      );
      const extension = mimeType.split('/').pop();
      const filename = `adk_live_audio_storage_${cacheType}_${timestampMs}.${extension}`;

      const revisionId = await invocationContext.artifactService.saveArtifact({
        filename,
        artifact: {inlineData: {data: combinedData, mimeType}},
      });

      const artifactRef = `artifact://${invocationContext.appName}/${invocationContext.userId}/${invocationContext.session.id}/_adk_live/${filename}#${revisionId}`;

      const role = cache[0].role;
      // Model events are authored by the agent, not the raw 'model' role.
      const author = role === 'model' ? invocationContext.agent.name : role;

      const audioEvent = createEvent({
        invocationId: invocationContext.invocationId,
        author,
        content: {
          role,
          parts: [{fileData: {fileUri: artifactRef, mimeType}}],
        },
        timestamp: cache[0].timestamp,
      });

      logger.debug(
        `Flushed ${cacheType} cache: ${cache.length} chunks saved as ${filename}`,
      );
      return audioEvent;
    } catch (error) {
      logger.error(`Failed to flush ${cacheType} cache`, error);
      return undefined;
    }
  }
}

/**
 * Concatenates the base64-encoded bytes of every chunk in a cache into one
 * base64 string. Chunks are decoded to raw bytes before concatenation so that
 * arbitrary-length chunks combine correctly.
 */
function concatAudioChunks(cache: RealtimeCacheEntry[]): string {
  const buffers = cache.map((entry) =>
    Buffer.from(entry.data.data ?? '', 'base64'),
  );
  return Buffer.concat(buffers).toString('base64');
}
