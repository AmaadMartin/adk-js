# Plugin close lifecycle

`PluginManager.close()` releases the resources the registered plugins hold. Reach for it when a plugin owns something the process must give back, such as a socket, a database handle, or a subprocess.

## Introduction

A plugin often outlives a single invocation. It may open a connection in its constructor and reuse it across many runs, so nothing in the run loop can decide when to shut it down. Without an explicit shutdown the connection stays open until the process exits, which leaks handles in a long-running server and hangs a short-lived script.

`BasePlugin.close()` is the hook for that shutdown. The default does nothing, so a plugin that holds no resource needs no override. `PluginManager.close()` calls the hook on every registered plugin. A `Runner` builds its own manager and publishes it as `runner.pluginManager`, so the owner of the runner decides when the plugins go away.

Two properties matter when you write an override.

- Closing is **sequential**, in registration order. A plugin that owns a transport is never torn down while a peer is still using it.
- Each plugin gets a **bounded** amount of time. A plugin that never finishes closing is abandoned so the rest still close.

## Get started

Override `close()` on your plugin, then close the manager when you are done with the runner.

```typescript
import {
  BasePlugin,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';

class MetricsPlugin extends BasePlugin {
  private readonly timer = setInterval(() => this.flush(), 10_000);

  constructor() {
    super('metrics');
  }

  override async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private async flush(): Promise<void> {
    // Send the buffered counters to your metrics backend.
  }
}

const runner = new Runner({
  appName: 'my_app',
  agent: new LlmAgent({name: 'root', model: 'gemini-2.5-flash'}),
  sessionService: new InMemorySessionService(),
  plugins: [new MetricsPlugin()],
});

try {
  // Drive the runner.
} finally {
  await runner.pluginManager.close();
}
```

## The close timeout

The manager's second constructor argument bounds how long each plugin gets. It defaults to `DEFAULT_PLUGIN_CLOSE_TIMEOUT_SECONDS`, which is 5 seconds, and it applies to each plugin separately rather than to the whole shutdown.

```typescript
import {PluginManager} from '@google/adk';

const manager = new PluginManager([new MetricsPlugin()], 10);
```

A value of zero or less waits indefinitely. Use it only when a plugin must finish, because one plugin that never settles then blocks the whole shutdown.

JavaScript cannot cancel a promise, so an expired timeout abandons the plugin rather than stopping its work. The manager stops waiting and moves to the next plugin.

## Borrowed plugins

A component that builds a nested runner over plugins another runner already uses does not own them. Tell the nested manager to skip closing, and the shared plugins survive the nested run.

```typescript
const shared = [new MetricsPlugin()];

const parent = new Runner({
  appName: 'my_app',
  agent: rootAgent,
  sessionService,
  plugins: shared,
});

const nested = new Runner({
  appName: 'my_app',
  agent: childAgent,
  sessionService,
  plugins: shared,
});
nested.pluginManager.setSkipClosingPlugins(true);
```

While the flag is set, `close()` returns without touching a plugin and without starting a close timeout. The last call wins, so `setSkipClosingPlugins(false)` restores normal closing.

## Failures

When one or more plugins fail, the manager still closes the rest, then rejects with an `AggregateError`. Its message names each failing plugin and its `errors` array carries the individual causes.

```typescript
try {
  await runner.pluginManager.close();
} catch (error: unknown) {
  if (error instanceof AggregateError) {
    // error.message: Failed to close plugins: 'metrics': socket still busy
    for (const cause of error.errors) {
      // cause.message: socket still busy
    }
  }
}
```

A timed-out plugin is reported the same way, with the message `Closing plugin '<name>' timed out after <n>s.`

## Guarantees

- Every registered plugin is closed, even when an earlier one throws or times out.
- Plugins close in registration order, one at a time.
- `close()` does not unregister anything, so a second call closes each plugin again. An override must be idempotent.
