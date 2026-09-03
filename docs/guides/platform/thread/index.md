# createThread

`createThread` hands you a unit of background work that you start and join
explicitly. Reach for it when a host platform must be able to replace how that
work runs.

## Introduction

Most background work in adk-js is an ordinary promise, and that is still the
right default. This module exists for the cases where the code that _starts_
the work is not the code that decides _how_ it runs. `createThread` returns a
`Thread` object with a `threading.Thread` shape — `start()`, `join()`,
`isAlive()`, and a `name` — so a caller can hold the handle, keep working, and
join later.

The value is the seam. `setThreadFactory` replaces the implementation for every
later `createThread` call, so a host that runs adk-js inside its own scheduler
supplies its own execution unit without the calling code changing. This mirrors
`google.adk.platform.thread` in adk-python, which swaps in an internal thread
package at import time when one is installed.

Be clear about what the default gives you: concurrency, not parallelism. The
target runs on the caller's event loop, so a synchronous long-running target
still blocks it. The default `Thread` is not an OS thread and it isolates
nothing. A caller that needs real parallelism installs a factory backed by
`node:worker_threads`; that is what the seam is for.

## Get started

```ts
import {createThread} from '@google/adk';

const thread = createThread(async () => {
  await doBackgroundWork();
});

thread.start();
// The target has not run yet. Keep working here.
await thread.join();
```

Arguments after the target are forwarded to it when the thread starts, and the
tuple stays typed:

```ts
import {createThread} from '@google/adk';

const attempts: string[] = [];
const thread = createThread(
  (attempt: number, label: string) => {
    attempts.push(`${label} attempt ${attempt}`);
  },
  1,
  'sync',
);
thread.start();
await thread.join();
```

`threading.Thread`'s keyword arguments have no TypeScript equivalent. Pass an
options object as an ordinary positional argument instead.

## Lifecycle

- `createThread` never runs the target. Only `start()` does.
- `start()` returns before the target runs. The target runs once the caller's
  current synchronous block yields.
- `join()` resolves after the target settles. You may call it more than once,
  and the target still runs exactly once.
- `isAlive()` is `false` before `start()`, `true` until the target settles, and
  `false` afterwards.

## Failure handling

A target that throws, or returns a rejected promise, does not fail the join.
The module logs the error once through the ADK logger, together with the thread
name, and `join()` resolves normally. This matches `threading.Thread`, which
sends the exception to `threading.excepthook` and lets `join()` return. Callers
that need the error must forward it out of the target themselves.

Two calls throw instead:

- A second `start()` on the same thread throws `Error`, matching Python's
  `RuntimeError: threads can only be started once`.
- `join()` before `start()` throws `Error`.

## Replacing the implementation

```ts
import {
  createThread,
  resetThreadFactory,
  setThreadFactory,
  type Thread,
  type ThreadFactory,
  type ThreadTarget,
} from '@google/adk';

declare function myPlatformThread<Args extends unknown[]>(
  target: ThreadTarget<Args>,
  args: Args,
): Thread;

const factory: ThreadFactory = {
  createThread<Args extends unknown[]>(
    target: ThreadTarget<Args>,
    ...args: Args
  ): Thread {
    return myPlatformThread(target, args);
  },
};

setThreadFactory(factory);
// Every later createThread call now goes to the factory.
resetThreadFactory();
```

`createThread` returns whatever the factory returned, unchanged. Threads that
already exist keep the implementation they were created with. A factory must
return an unstarted `Thread`; the module does not check this.

There is no `daemon` flag. A pending promise does not hold the Node event loop
open, so the flag would have no reader.
