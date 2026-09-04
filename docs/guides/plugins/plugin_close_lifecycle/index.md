# Plugin close lifecycle

`Runner.close()` releases the resources a runner holds: the toolsets its agent tree declares, then every registered plugin. Reach for it when a plugin owns something the process must give back, such as a socket, a database handle, or a subprocess.

## Introduction

A plugin often outlives a single invocation. It may open a connection in its constructor and reuse it across many runs, so nothing in the run loop can decide when to shut it down. Without an explicit shutdown the connection stays open until the process exits, which leaks handles in a long-running server and hangs a short-lived script.

`BasePlugin.close()` is the hook for that shutdown. The default does nothing, so a plugin that holds no resource needs no override. `PluginManager.close()` calls the hook on every registered plugin, and `Runner.close()` calls the manager after it has closed the toolsets. A `Runner` also publishes its manager as `runner.pluginManager`, so a caller can reach the plugins directly.

Two properties matter when you write an override.

- Closing is **sequential**, in registration order. A plugin that owns a transport is never torn down while a peer is still using it.
- Each plugin gets a **bounded** amount of time. A plugin that never finishes closing is abandoned so the rest still close.

`Runner.close()` is separate from the toolset cleanup that `runAsync` already performs at the end of each invocation. That cleanup runs per invocation; `close()` runs once, when you are finished with the runner.

## Get started

Override `close()` on your plugin, then close the runner when you are done with it.

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
  await runner.close();
}
```

## The close timeout

`pluginCloseTimeoutSeconds` bounds how long each plugin gets. It defaults to `DEFAULT_PLUGIN_CLOSE_TIMEOUT_SECONDS`, which is 5 seconds, and it applies to each plugin separately rather than to the whole shutdown.

```typescript
const runner = new Runner({
  appName: 'my_app',
  agent,
  sessionService,
  pluginCloseTimeoutSeconds: 10,
});
```

A `PluginManager` you build yourself takes the same timeout as its second constructor argument: `new PluginManager([new MetricsPlugin()], 10)`.

A value of zero or less waits indefinitely. Use it only when a plugin must finish, because one plugin that never settles then blocks the whole shutdown.

JavaScript cannot cancel a promise, so an expired timeout abandons the plugin rather than stopping its work. The manager stops waiting and moves to the next plugin.

## Sharing plugins with another component

A component that borrows another component's plugin list must not close those plugins: the owner is still using them. Call `setSkipClosingPlugins(true)` on the borrower's manager, and its `close()` does nothing.

```typescript
const borrowed = new PluginManager(ownerPlugins);
borrowed.setSkipClosingPlugins(true);

// Does nothing. The owner still holds live plugins.
await borrowed.close();
```

A nested runner borrows the same way. It builds its own manager over the shared list, so tell that manager to skip closing.

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

The switch is checked before the first plugin, so a borrowed plugin that never finishes closing cannot delay the borrower either. It is reversible: pass `false` to close normally again.

## Failures

`Runner.close()` reports plugin failures and swallows toolset failures. A toolset that throws must not hide the state of the plugins, which own the resources you called `close()` for.

When one or more plugins fail, the manager still closes the rest, then rejects with an `AggregateError`. Its message names each failing plugin and its `errors` array carries the individual causes.

```typescript
try {
  await runner.close();
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
- `Runner.close()` closes each plugin once. A second call closes the toolsets again, because a run reopens them, and leaves the plugins alone.
- `PluginManager.close()` does not unregister anything, so a second call on the manager closes each plugin again.
- An override must be idempotent too, because a plugin registered on two runners is closed by each of them.
- `PluginManager.close()` does nothing at all after `setSkipClosingPlugins(true)`.
