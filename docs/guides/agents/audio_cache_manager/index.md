# AudioCacheManager

`AudioCacheManager` buffers the audio chunks of a live (bidirectional
streaming) run on the invocation context, and writes each buffer out as one
artifact. Reach for it when you want a recording of a live turn without
flooding the session with per-chunk events.

## Introduction

A live run receives many small audio chunks per second in each direction. Each
chunk is a fraction of a second of PCM. Saving one artifact per chunk, or
appending one session event per chunk, produces thousands of objects for a
short conversation and makes the session history unreadable.

The manager holds the chunks instead. `cacheAudio` appends a chunk to the input
(user) cache or the output (model) cache on the `InvocationContext`.
`flushCaches` concatenates a cache into a single audio payload, saves it through
the invocation's `SessionArtifactService`, and returns an `Event` whose content
carries a file-data reference to that artifact. Nothing is written to the
session: the manager returns the events, and the caller decides whether to
append them.

The artifact reference has this shape:

```
artifact://{appName}/{userId}/{sessionId}/_adk_live/{filename}#{revisionId}
```

The filename is `adk_live_audio_storage_{input_audio|output_audio}_{timestamp}.{extension}`.
The timestamp is that of the **first** chunk in the buffer, so the name records
when the recording started rather than when it was flushed. The extension comes
from the blob's MIME subtype.

Nothing in adk-js constructs an `AudioCacheManager` yet. It is a library class
you drive yourself, from a live loop or from your own code.

## Get started

`ctx` is the `InvocationContext` of a live run, so its `artifactService` is
already set by the `Runner`. Chunk data is a base64 string, as everywhere in
`@google/genai`.

```ts
import {AudioCacheManager, Event, InvocationContext} from '@google/adk';

const manager = new AudioCacheManager();

/** Buffers one chunk in each direction, then writes both out. */
export async function recordTurn(
  ctx: InvocationContext,
  userChunk: string,
  modelChunk: string,
): Promise<Event[]> {
  manager.cacheAudio(ctx, {data: userChunk, mimeType: 'audio/pcm'}, 'input');
  manager.cacheAudio(ctx, {data: modelChunk, mimeType: 'audio/pcm'}, 'output');

  // events[0].author is 'user'; events[1].author is the agent's name.
  return manager.flushCaches(ctx);
}
```

`flushCaches` takes an options object to flush one direction only, which is
what a live loop does when the model is interrupted:

```ts
await manager.flushCaches(ctx, {flushUserAudio: false, flushModelAudio: true});
```

`getCacheStats(ctx)` reports the chunk counts and the decoded byte totals of
both caches.

## Configuration

The constructor takes an optional `AudioCacheConfig`, which records the bounds
a cache should stay inside. Build one with `createAudioCacheConfig`, which
fills anything you leave out:

```ts
import {AudioCacheManager, createAudioCacheConfig} from '@google/adk';

const manager = new AudioCacheManager(
  createAudioCacheConfig({maxCacheSizeBytes: 5 * 1024 * 1024}),
);
```

The three fields and their defaults:

| Field                     | Default             | Meaning                                             |
| ------------------------- | ------------------- | --------------------------------------------------- |
| `maxCacheSizeBytes`       | `10485760` (10 MiB) | Maximum cache size in bytes before an auto-flush.   |
| `maxCacheDurationSeconds` | `300`               | Maximum time to keep data in the cache, in seconds. |
| `autoFlushThreshold`      | `100`               | Number of chunks that triggers an auto-flush.       |

**The manager reads none of them.** It stores the config on its `config`
property and never flushes on its own, exactly as adk-python's
`AudioCacheConfig` behaves. The fields are there so a host can state its bounds
in one place and act on them:

```ts
const stats = manager.getCacheStats(ctx);
if (stats.inputChunks >= manager.config.autoFlushThreshold) {
  await manager.flushCaches(ctx, {
    flushUserAudio: true,
    flushModelAudio: false,
  });
}
```

The factory rejects nothing. adk-python's `AudioCacheConfig` is a plain class
with no validators, so a negative or zero bound is stored, not refused.

## Guarantees

- **A cache is cleared only when its own flush succeeds.** If the artifact
  service throws, the manager logs the failure, returns no event for that
  direction, and leaves the audio buffered. Losing a turn's audio must not end
  a live session.
- **A missing artifact service is not an error.** The flush is skipped and the
  caches are left alone.
- **Flushing is selective.** Turning one direction off leaves that cache
  untouched and makes no artifact call for it.
- **A model event is authored by the agent**, not by the literal string
  `'model'`, while the event content keeps the `'model'` role.
- **Bytes survive the round trip.** Chunks are decoded, concatenated as bytes,
  and re-encoded, so a chunk whose length is not a multiple of three does not
  corrupt the rest of the buffer.

`cacheAudio` throws `InputValidationError` when the blob carries no data, and
when the cache type is neither `'input'` nor `'output'`. A rejected chunk
leaves the cache untouched.

## Differences from adk-python

This class ports `src/google/adk/live/_audio_cache_manager.py`. Five things
differ:

- **Chunk data is base64 text**, since a `@google/genai` `Blob` carries a
  base64 `string` where a Python blob carries `bytes`. The byte totals from
  `getCacheStats` are decoded byte counts, not string lengths.
- **Timestamps are epoch milliseconds**, matching adk-js event timestamps.
  adk-python stores epoch seconds and scales them for the filename, so the
  filenames agree.
- **`AudioCacheConfig` is an interface with a factory**, where adk-python uses
  a class with keyword defaults. The field names are camelCase and the values
  are the same.
- **A bad argument raises `InputValidationError`**, adk-js's typed argument
  error, where adk-python raises `ValueError`. The message text is unchanged.
- **A malformed entry is not rejected at runtime.** adk-python's
  `RealtimeCacheEntry` is a pydantic model with `extra='forbid'`. adk-js's is a
  structural interface, so TypeScript checks it at compile time and nothing
  checks it after that.
