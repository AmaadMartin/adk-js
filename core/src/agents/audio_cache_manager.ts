/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';
import {Event, createEvent} from '../events/event.js';
import {base64DecodeBytes, base64Encode} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {
  AudioCacheConfig,
  createAudioCacheConfig,
} from './audio_cache_config.js';
import {InvocationContext, requireAgent} from './invocation_context.js';
import {RealtimeCacheEntry} from './realtime_cache_entry.js';

const DEFAULT_AUDIO_MIME_TYPE = 'audio/pcm';

/** Which cache a chunk belongs to. */
export type AudioCacheType = 'input' | 'output';

/** Options for {@link AudioCacheManager.flushCaches}. */
export interface FlushCachesOptions {
  /** Whether to flush the input (user) audio cache. Defaults to true. */
  flushUserAudio?: boolean;
  /** Whether to flush the output (model) audio cache. Defaults to true. */
  flushModelAudio?: boolean;
}

/** Chunk and byte totals for both caches. */
export interface AudioCacheStats {
  inputChunks: number;
  outputChunks: number;
  inputBytes: number;
  outputBytes: number;
  totalChunks: number;
  totalBytes: number;
}

/** The cache identifier that appears in an artifact filename. */
type AudioCacheLabel = 'input_audio' | 'output_audio';

function requireAudioData(blob: Blob): string {
  if (!blob.data) {
    throw new InputValidationError('Audio blobs must contain byte data.');
  }
  return blob.data;
}

/**
 * Decodes one cached chunk to bytes, treating an entry with no data as empty.
 *
 * `cacheAudio` rejects a data-less blob, so such an entry only reaches here
 * when a caller seeds a cache through `InvocationContextParams` directly.
 * Every reader below counts it as zero bytes rather than raising, so one
 * malformed entry cannot wedge a cache that no flush can ever drain.
 */
function decodedChunk(entry: RealtimeCacheEntry): Uint8Array {
  return base64DecodeBytes(entry.data.data ?? '');
}

/**
 * Concatenates the chunks of `cache` into one audio payload.
 *
 * The chunks are decoded before they are joined, because a chunk whose decoded
 * length is not a multiple of three carries base64 padding. Joining the
 * encoded strings would leave that padding mid-payload and corrupt everything
 * after it.
 */
function combineAudioChunks(cache: RealtimeCacheEntry[]): Uint8Array {
  const chunks = cache.map(decodedChunk);
  const combined = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );

  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function buildArtifactFilename(
  cacheLabel: AudioCacheLabel,
  timestampMs: number,
  mimeType: string,
): string {
  // adk-python scales its epoch-seconds timestamp by 1000 here, so both SDKs
  // put epoch milliseconds in the filename.
  const extension = mimeType.split('/').pop();
  return `adk_live_audio_storage_${cacheLabel}_${timestampMs}.${extension}`;
}

function totalDecodedBytes(cache: RealtimeCacheEntry[]): number {
  return cache.reduce(
    (total, entry) => total + decodedChunk(entry).byteLength,
    0,
  );
}

/**
 * Saves the non-empty `cache` as one artifact and returns the event that
 * points at it.
 *
 * Returns undefined when there is no artifact service, and when the save
 * fails. A live session must survive the loss of one turn's audio, so the
 * failure is logged rather than raised, and the caller keeps the cache.
 */
async function flushCacheToServices(
  ctx: InvocationContext,
  cache: RealtimeCacheEntry[],
  cacheLabel: AudioCacheLabel,
): Promise<Event | undefined> {
  if (!ctx.artifactService) {
    logger.debug('Skipping cache flush: no artifact service');
    return undefined;
  }

  const [first] = cache;
  try {
    const mimeType = first.data.mimeType || DEFAULT_AUDIO_MIME_TYPE;
    const combinedAudio = combineAudioChunks(cache);
    const filename = buildArtifactFilename(
      cacheLabel,
      first.timestamp,
      mimeType,
    );

    const revisionId = await ctx.artifactService.saveArtifact({
      filename,
      artifact: {
        inlineData: {data: base64Encode(combinedAudio), mimeType},
      },
    });

    // A model event is authored by the agent that produced it, while its
    // content keeps the 'model' role.
    const author = first.role === 'model' ? requireAgent(ctx).name : first.role;

    logger.debug(
      `Flushed ${cacheLabel} cache: ${cache.length} chunks, ` +
        `${combinedAudio.byteLength} bytes, saved as ${filename}`,
    );

    return createEvent({
      invocationId: ctx.invocationId,
      author,
      content: {
        role: first.role,
        parts: [
          {
            fileData: {
              fileUri: `artifact://${ctx.appName}/${ctx.userId}/${ctx.session.id}/_adk_live/${filename}#${revisionId}`,
              mimeType,
            },
          },
        ],
      },
      timestamp: first.timestamp,
    });
  } catch (e: unknown) {
    logger.error(`Failed to flush ${cacheLabel} cache:`, e);
    return undefined;
  }
}

/**
 * Buffers realtime audio for a live invocation and writes it out as artifacts.
 *
 * A live run receives many small audio chunks per second in each direction.
 * Saving each one as its own artifact is unusable, so the manager holds them
 * on the invocation context and writes one artifact per direction per flush.
 * Each flush returns an event carrying a file-data reference to the artifact;
 * the caller decides whether to append it to the session.
 *
 * Ports `google/adk-python` `src/google/adk/live/_audio_cache_manager.py`.
 */
export class AudioCacheManager {
  /**
   * The cache bounds this manager advertises.
   *
   * The manager never reads them, so it never flushes on its own. adk-python
   * stores the same config and consults none of its fields either. A live loop
   * that wants an automatic flush reads these bounds and calls
   * {@link AudioCacheManager.flushCaches} itself.
   */
  readonly config: AudioCacheConfig;

  constructor(config: AudioCacheConfig = createAudioCacheConfig()) {
    this.config = config;
  }

  /**
   * Appends one incoming user chunk or outgoing model chunk to its cache.
   *
   * @throws {InputValidationError} if the blob carries no data, or if
   *     `cacheType` is neither 'input' nor 'output'.
   */
  cacheAudio(
    ctx: InvocationContext,
    audioBlob: Blob,
    cacheType: AudioCacheType,
  ): void {
    const audioData = requireAudioData(audioBlob);

    let cache: RealtimeCacheEntry[];
    let role: string;
    if (cacheType === 'input') {
      ctx.inputRealtimeCache ??= [];
      cache = ctx.inputRealtimeCache;
      role = 'user';
    } else if (cacheType === 'output') {
      ctx.outputRealtimeCache ??= [];
      cache = ctx.outputRealtimeCache;
      role = 'model';
    } else {
      throw new InputValidationError(
        "cacheType must be either 'input' or 'output'",
      );
    }

    cache.push({role, data: audioBlob, timestamp: Date.now()});

    logger.debug(
      `Cached ${cacheType} audio chunk: ${audioData.length} base64 ` +
        `characters, cache size: ${cache.length}`,
    );
  }

  /**
   * Flushes either or both audio caches to the artifact service.
   *
   * Each artifact is referenced as
   * `artifact://{appName}/{userId}/{sessionId}/_adk_live/{filename}#{revisionId}`.
   * A cache is cleared only when its own flush succeeds, so a failure keeps
   * the audio for the next attempt. Video data is not supported.
   *
   * @return The events created, input cache first. Empty when nothing was
   *     flushed.
   */
  async flushCaches(
    ctx: InvocationContext,
    options: FlushCachesOptions = {},
  ): Promise<Event[]> {
    const {flushUserAudio = true, flushModelAudio = true} = options;
    const flushedEvents: Event[] = [];

    if (flushUserAudio && ctx.inputRealtimeCache?.length) {
      const audioEvent = await flushCacheToServices(
        ctx,
        ctx.inputRealtimeCache,
        'input_audio',
      );
      if (audioEvent) {
        flushedEvents.push(audioEvent);
        ctx.inputRealtimeCache = [];
      }
    }

    if (flushModelAudio && ctx.outputRealtimeCache?.length) {
      const audioEvent = await flushCacheToServices(
        ctx,
        ctx.outputRealtimeCache,
        'output_audio',
      );
      if (audioEvent) {
        flushedEvents.push(audioEvent);
        ctx.outputRealtimeCache = [];
      }
    }

    return flushedEvents;
  }

  /**
   * Reports the chunk and decoded-byte totals of both caches.
   *
   * An entry carrying no data counts as a chunk of zero bytes, matching what
   * a flush writes for it.
   */
  getCacheStats(ctx: InvocationContext): AudioCacheStats {
    const inputCache = ctx.inputRealtimeCache ?? [];
    const outputCache = ctx.outputRealtimeCache ?? [];
    const inputBytes = totalDecodedBytes(inputCache);
    const outputBytes = totalDecodedBytes(outputCache);

    return {
      inputChunks: inputCache.length,
      outputChunks: outputCache.length,
      inputBytes,
      outputBytes,
      totalChunks: inputCache.length + outputCache.length,
      totalBytes: inputBytes + outputBytes,
    };
  }
}
