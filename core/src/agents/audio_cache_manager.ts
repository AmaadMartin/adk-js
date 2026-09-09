/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';

import {createEvent, Event} from '../events/event.js';
import {LlmResponse} from '../models/llm_response.js';
import {logger} from '../utils/logger.js';

import {InvocationContext, requireAgent} from './invocation_context.js';
import {RealtimeCacheEntry} from './realtime_cache_entry.js';

/** Cap on the retained audio bytes per direction when none is configured. */
export const DEFAULT_MAX_LIVE_AUDIO_CACHE_BYTES = 10 * 1024 * 1024;

/** Mime type assumed when a live audio chunk declares none. */
const DEFAULT_AUDIO_MIME_TYPE = 'audio/pcm';

/** Filename extension used when the mime subtype sanitizes to nothing. */
const FALLBACK_FILENAME_EXTENSION = 'bin';

/** Which side of the conversation a chunk of live audio came from. */
export type AudioCacheType = 'input' | 'output';

/** Options for {@link AudioCacheManager.flushCaches}. */
export interface FlushCachesOptions {
  /** Whether to flush the user's audio too. Defaults to true. */
  flushUserAudio?: boolean;
}

/** The decoded byte length of a cache, in bytes. */
function cacheByteLength(cache: readonly RealtimeCacheEntry[]): number {
  return cache.reduce(
    (total, entry) =>
      total + Buffer.byteLength(entry.data.data ?? '', 'base64'),
    0,
  );
}

/**
 * Concatenates the cached chunks into a single base64 payload.
 *
 * The chunks are decoded first: base64 does not concatenate, because a chunk
 * whose byte length is not a multiple of three ends in padding that would land
 * in the middle of the combined payload.
 */
function combineAudioChunks(cache: readonly RealtimeCacheEntry[]): string {
  const chunks = cache.map((entry) =>
    Buffer.from(entry.data.data ?? '', 'base64'),
  );
  return Buffer.concat(chunks).toString('base64');
}

/**
 * The filename extension for an audio mime type.
 *
 * The mime type comes off the wire, and the extension becomes a path segment
 * in `FileArtifactService`, so parameters are cut (`audio/pcm;rate=24000` gives
 * `pcm`) and any remaining character outside `[a-z0-9]` is replaced.
 */
function audioFilenameExtension(mimeType: string): string {
  const subtype = mimeType.slice(mimeType.lastIndexOf('/') + 1);
  const sanitized = subtype
    .split(';')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');
  return sanitized || FALLBACK_FILENAME_EXTENSION;
}

/**
 * Accumulates the live audio of a turn and writes it to the artifact service.
 *
 * A live session streams audio in many small chunks. Storing each one in the
 * session would bloat it, so the manager holds them on the
 * {@link InvocationContext} and, when the turn ends, writes one audio artifact
 * per direction and returns an {@link Event} that references it. The caches are
 * capped, so a turn that never ends cannot exhaust memory.
 *
 * Used by `LlmAgent`'s live flow when `RunConfig.saveLiveBlob` is on.
 */
export class AudioCacheManager {
  constructor(
    private readonly maxCacheBytes = DEFAULT_MAX_LIVE_AUDIO_CACHE_BYTES,
  ) {}

  /**
   * Appends an audio chunk to the cache for `cacheType`, evicting the oldest
   * chunks first when the cache would otherwise exceed its cap.
   *
   * @throws if the blob carries no data.
   */
  cacheAudio(
    invocationContext: InvocationContext,
    audioBlob: Blob,
    cacheType: AudioCacheType,
  ): void {
    if (!audioBlob.data) {
      throw new Error('Audio blobs must contain data.');
    }
    const isInput = cacheType === 'input';
    const cache = isInput
      ? (invocationContext.inputRealtimeCache ??= [])
      : (invocationContext.outputRealtimeCache ??= []);

    this.evictToFit(cache, Buffer.byteLength(audioBlob.data, 'base64'));
    cache.push({
      role: isInput ? 'user' : 'model',
      data: audioBlob,
      timestamp: Date.now(),
    });
  }

  /**
   * Writes the model's audio, and optionally the user's, to the artifact
   * service as one audio artifact each, and returns an {@link Event} per cache
   * written.
   *
   * A cache that was written is cleared. A cache whose write failed is kept, so
   * its audio joins the next flush rather than being lost.
   */
  async flushCaches(
    invocationContext: InvocationContext,
    options: FlushCachesOptions = {},
  ): Promise<Event[]> {
    const {flushUserAudio = true} = options;
    const flushedEvents: Event[] = [];

    const inputCache = invocationContext.inputRealtimeCache;
    if (flushUserAudio && inputCache?.length) {
      const event = await this.flushCache(
        invocationContext,
        inputCache,
        'input_audio',
      );
      if (event) {
        flushedEvents.push(event);
        // Cleared in place: a sub-agent context shares this array by reference.
        inputCache.length = 0;
      }
    }

    const outputCache = invocationContext.outputRealtimeCache;
    if (outputCache?.length) {
      const event = await this.flushCache(
        invocationContext,
        outputCache,
        'output_audio',
      );
      if (event) {
        flushedEvents.push(event);
        outputCache.length = 0;
      }
    }

    return flushedEvents;
  }

  /**
   * Flushes the caches that a live control response calls for: an interruption
   * ends the model's turn only, while a completed turn ends both sides.
   */
  async handleControlEventFlush(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): Promise<Event[]> {
    if (!llmResponse.interrupted && !llmResponse.turnComplete) {
      return [];
    }
    return this.flushCaches(invocationContext, {
      flushUserAudio: !llmResponse.interrupted,
    });
  }

  /** Drops the oldest chunks until `incomingBytes` more would fit. */
  private evictToFit(cache: RealtimeCacheEntry[], incomingBytes: number): void {
    let evicted = 0;
    while (
      cache.length > 0 &&
      cacheByteLength(cache) + incomingBytes > this.maxCacheBytes
    ) {
      cache.shift();
      evicted += 1;
    }
    if (evicted > 0) {
      logger.debug(
        `Dropped ${evicted} live audio chunk(s) to stay within ${this.maxCacheBytes} bytes.`,
      );
    }
  }

  /**
   * Writes one non-empty cache to the artifact service and builds the event
   * that references it, or returns undefined when it could not be written.
   */
  private async flushCache(
    invocationContext: InvocationContext,
    cache: readonly RealtimeCacheEntry[],
    cacheType: 'input_audio' | 'output_audio',
  ): Promise<Event | undefined> {
    const artifactService = invocationContext.artifactService;
    if (!artifactService) {
      logger.debug(
        `Keeping the ${cacheType} cache: no artifact service is configured.`,
      );
      return undefined;
    }

    const first = cache[0];
    const mimeType = first.data.mimeType ?? DEFAULT_AUDIO_MIME_TYPE;
    const filename = `adk_live_audio_storage_${cacheType}_${first.timestamp}.${audioFilenameExtension(mimeType)}`;

    try {
      const revisionId = await artifactService.saveArtifact({
        filename,
        artifact: {
          inlineData: {data: combineAudioChunks(cache), mimeType},
        },
      });
      const artifactRef = `artifact://${invocationContext.appName}/${invocationContext.userId}/${invocationContext.session.id}/_adk_live/${filename}#${revisionId}`;
      logger.debug(
        `Flushed ${cache.length} ${cacheType} chunk(s) to ${filename}.`,
      );
      return createEvent({
        invocationId: invocationContext.invocationId,
        branch: invocationContext.branch,
        author:
          first.role === 'model'
            ? requireAgent(invocationContext).name
            : first.role,
        content: {
          role: first.role,
          parts: [{fileData: {fileUri: artifactRef, mimeType}}],
        },
        timestamp: first.timestamp,
      });
    } catch (error) {
      logger.error(`Failed to flush the ${cacheType} cache:`, error);
      return undefined;
    }
  }
}
