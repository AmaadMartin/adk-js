/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob, Part} from '@google/genai';

import {createEvent, Event} from '../events/event.js';
import {logger} from '../utils/logger.js';

import {InvocationContext} from './invocation_context.js';
import {RealtimeCacheEntry} from './realtime_cache_entry.js';

/** Default maximum cache size in bytes before auto-flush (10 MB). */
export const DEFAULT_MAX_CACHE_SIZE_BYTES = 10 * 1024 * 1024;

/** Default maximum duration to keep data in cache (5 minutes, in seconds). */
export const DEFAULT_MAX_CACHE_DURATION_SECONDS = 300;

/** Default number of cached chunks that triggers auto-flush. */
export const DEFAULT_AUTO_FLUSH_THRESHOLD = 100;

/** MIME type used when a cached audio chunk does not declare one. */
const DEFAULT_AUDIO_MIME_TYPE = 'audio/pcm';

/** Prefix of the aggregated live-audio artifact filename. */
const AUDIO_FILENAME_PREFIX = 'adk_live_audio_storage';

/** Virtual directory segment for live-audio artifacts in the artifact URI. */
const LIVE_AUDIO_DIR = '_adk_live';

/**
 * Configuration for audio caching behavior.
 *
 * These values are carried for parity and forward-compatibility; they are not
 * yet enforced (no size/duration/threshold auto-flush) by
 * {@link AudioCacheManager}.
 */
export interface AudioCacheConfig {
  /** Maximum cache size in bytes before auto-flush. */
  maxCacheSizeBytes: number;
  /** Maximum duration, in seconds, to keep data in cache. */
  maxCacheDurationSeconds: number;
  /** Number of cached chunks that triggers auto-flush. */
  autoFlushThreshold: number;
}

/**
 * Creates an {@link AudioCacheConfig}, applying defaults for any omitted field.
 *
 * @param overrides - Optional partial config overriding the defaults.
 * @returns A fully-populated {@link AudioCacheConfig}.
 */
export function createAudioCacheConfig(
  overrides: Partial<AudioCacheConfig> = {},
): AudioCacheConfig {
  return {
    maxCacheSizeBytes: DEFAULT_MAX_CACHE_SIZE_BYTES,
    maxCacheDurationSeconds: DEFAULT_MAX_CACHE_DURATION_SECONDS,
    autoFlushThreshold: DEFAULT_AUTO_FLUSH_THRESHOLD,
    ...overrides,
  };
}

/**
 * Statistics describing the current live-audio cache state.
 */
export interface AudioCacheStats {
  /** Number of cached input (user) chunks. */
  inputChunks: number;
  /** Number of cached output (model) chunks. */
  outputChunks: number;
  /** Decoded byte count of all cached input chunks. */
  inputBytes: number;
  /** Decoded byte count of all cached output chunks. */
  outputBytes: number;
  /** Total number of cached chunks across both directions. */
  totalChunks: number;
  /** Total decoded byte count across both directions. */
  totalBytes: number;
}

/**
 * Manages audio caching and flushing for live streaming flows.
 *
 * Live model audio is not persisted to the session as raw `inline_data` blobs.
 * Instead, this manager caches input (user) and output (model) audio chunks on
 * the {@link InvocationContext} and, on flush, aggregates each direction into a
 * single audio artifact. The returned {@link Event} carries only a lightweight
 * `file_data` reference to the stored artifact, which the caller may persist to
 * the session.
 */
export class AudioCacheManager {
  private readonly config: AudioCacheConfig;

  /**
   * @param config - Configuration for audio caching behavior. Defaults to
   *     {@link createAudioCacheConfig}.
   */
  constructor(config: AudioCacheConfig = createAudioCacheConfig()) {
    this.config = config;
  }

  /**
   * Caches an incoming user (input) or outgoing model (output) audio chunk.
   *
   * @param invocationContext - The current invocation context.
   * @param audioBlob - The audio data chunk to cache.
   * @param cacheType - Which cache to append to: `'input'` or `'output'`.
   * @throws {Error} If `cacheType` is not `'input'` or `'output'`.
   */
  cacheAudio(
    invocationContext: InvocationContext,
    audioBlob: Blob,
    cacheType: 'input' | 'output',
  ): void {
    let cache: RealtimeCacheEntry[];
    let role: string;
    if (cacheType === 'input') {
      if (!invocationContext.inputRealtimeCache) {
        invocationContext.inputRealtimeCache = [];
      }
      cache = invocationContext.inputRealtimeCache;
      role = 'user';
    } else if (cacheType === 'output') {
      if (!invocationContext.outputRealtimeCache) {
        invocationContext.outputRealtimeCache = [];
      }
      cache = invocationContext.outputRealtimeCache;
      role = 'model';
    } else {
      throw new Error("cacheType must be either 'input' or 'output'");
    }

    cache.push({role, data: audioBlob, timestamp: Date.now()});
    logger.debug(
      `Cached ${cacheType} audio chunk, cache size: ${cache.length}`,
    );
  }

  /**
   * Flushes the audio caches to the artifact service.
   *
   * Each non-empty, selected cache is aggregated into a single audio artifact
   * and cleared once a corresponding {@link Event} is produced. The returned
   * events carry a `file_data` reference to the stored artifact; this method
   * never writes to the session itself.
   *
   * @param invocationContext - The invocation context holding the caches.
   * @param options - Which directions to flush. Both default to `true`.
   * @returns The events created from the flushed caches (input before output).
   */
  async flushCaches(
    invocationContext: InvocationContext,
    options: {flushUserAudio?: boolean; flushModelAudio?: boolean} = {},
  ): Promise<Event[]> {
    const {flushUserAudio = true, flushModelAudio = true} = options;
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
   * Returns statistics about the current cache state.
   *
   * @param invocationContext - The invocation context to inspect. Undefined
   *     caches are treated as empty.
   * @returns The {@link AudioCacheStats} for both cache directions.
   */
  getCacheStats(invocationContext: InvocationContext): AudioCacheStats {
    const inputCache = invocationContext.inputRealtimeCache ?? [];
    const outputCache = invocationContext.outputRealtimeCache ?? [];

    const inputChunks = inputCache.length;
    const outputChunks = outputCache.length;
    const inputBytes = decodedByteLength(inputCache);
    const outputBytes = decodedByteLength(outputCache);

    return {
      inputChunks,
      outputChunks,
      inputBytes,
      outputBytes,
      totalChunks: inputChunks + outputChunks,
      totalBytes: inputBytes + outputBytes,
    };
  }

  /**
   * Aggregates one cache into an artifact and builds its reference event.
   *
   * The artifact service stores the combined blob; the returned event stores a
   * `file_data` reference to it. Failures (missing artifact service, empty
   * cache, or a save error) yield `undefined` and leave the cache intact.
   *
   * @param invocationContext - The invocation context.
   * @param audioCache - The cache entries to aggregate and store.
   * @param cacheType - Filename discriminator: `'input_audio'` or
   *     `'output_audio'`.
   * @returns The created event, or `undefined` if nothing was flushed.
   */
  private async flushCacheToServices(
    invocationContext: InvocationContext,
    audioCache: RealtimeCacheEntry[],
    cacheType: string,
  ): Promise<Event | undefined> {
    if (!invocationContext.artifactService || audioCache.length === 0) {
      logger.debug('Skipping cache flush: no artifact service or empty cache');
      return undefined;
    }

    try {
      const {role, timestamp} = audioCache[0];
      const mimeType = audioCache[0].data.mimeType || DEFAULT_AUDIO_MIME_TYPE;
      const filename = buildArtifactFilename(cacheType, timestamp, mimeType);

      const combinedAudioPart: Part = {
        inlineData: {data: concatBase64Chunks(audioCache), mimeType},
      };

      const revisionId = await invocationContext.artifactService.saveArtifact({
        filename,
        artifact: combinedAudioPart,
      });

      const fileUri = buildArtifactUri(
        invocationContext.appName,
        invocationContext.userId,
        invocationContext.session.id,
        filename,
        revisionId,
      );

      // For model audio the event author is the agent name, not the role.
      const author = role === 'model' ? invocationContext.agent.name : role;

      return createEvent({
        invocationId: invocationContext.invocationId,
        author,
        content: {role, parts: [{fileData: {fileUri, mimeType}}]},
        timestamp,
      });
    } catch (e) {
      logger.error(`Failed to flush ${cacheType} cache`, e);
      return undefined;
    }
  }
}

/**
 * Concatenates the decoded bytes of cached audio chunks into one base64 string.
 *
 * `Blob.data` is base64-encoded, so each chunk is decoded to raw bytes before
 * concatenation to avoid corrupting the audio, then the joined bytes are
 * re-encoded to base64.
 *
 * @param cache - The cache entries whose audio bytes are joined.
 * @returns The base64-encoded concatenation of all chunk bytes.
 */
export function concatBase64Chunks(cache: RealtimeCacheEntry[]): string {
  const combined = Buffer.concat(
    cache.map((entry) => Buffer.from(entry.data.data ?? '', 'base64')),
  );
  return combined.toString('base64');
}

/**
 * Builds the aggregated-audio artifact filename.
 *
 * @param cacheType - Filename discriminator (`'input_audio'` /
 *     `'output_audio'`).
 * @param timestamp - The first chunk's epoch-milliseconds timestamp.
 * @param mimeType - The artifact MIME type; its subtype becomes the extension.
 * @returns The artifact filename, e.g. `adk_live_audio_storage_input_audio_<ts>.pcm`.
 */
export function buildArtifactFilename(
  cacheType: string,
  timestamp: number,
  mimeType: string,
): string {
  const extension = mimeType.split('/').pop();
  return `${AUDIO_FILENAME_PREFIX}_${cacheType}_${timestamp}.${extension}`;
}

/**
 * Builds the `artifact://` URI that references a stored live-audio artifact.
 *
 * @param appName - The application name.
 * @param userId - The user ID.
 * @param sessionId - The session ID.
 * @param filename - The stored artifact filename.
 * @param revisionId - The revision returned by `saveArtifact`.
 * @returns The fully-qualified `artifact://` URI including the revision suffix.
 */
export function buildArtifactUri(
  appName: string,
  userId: string,
  sessionId: string,
  filename: string,
  revisionId: number,
): string {
  return `artifact://${appName}/${userId}/${sessionId}/${LIVE_AUDIO_DIR}/${filename}#${revisionId}`;
}

/**
 * Sums the decoded byte lengths of a cache's base64-encoded audio chunks.
 *
 * @param cache - The cache entries to measure.
 * @returns The total number of decoded bytes.
 */
function decodedByteLength(cache: RealtimeCacheEntry[]): number {
  return cache.reduce(
    (total, entry) =>
      total + Buffer.from(entry.data.data ?? '', 'base64').length,
    0,
  );
}
