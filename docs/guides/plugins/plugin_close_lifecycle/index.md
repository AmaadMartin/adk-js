# Plugin close lifecycle

`PluginManager.close()` releases the resources the registered plugins hold. Reach for it when a plugin owns something the process must give back, such as a socket, a database handle, or a subprocess.

## Introduction

A plugin often outlives a single invocation. It may open a connection in its constructor and reuse it across many runs, so nothing in the run loop can decide when to shut it down. Without an explicit shutdown the connection stays open until the process exits, which leaks handles in a long-running server and hangs a short-lived script.

`BasePlugin.close()` is the hook for that shutdown. The default does nothing, so a plugin that holds no resource needs no override. `PluginManager.close()` calls the hook on every registered plugin.

Two properties matter when you write an override.

- Closing is **sequential**, in registration order. A plugin that owns a transport is never torn down while a peer is still using it.
- Each plugin gets a **bounded** amount of time. A plugin that never finishes closing is abandoned so the rest still close.

## Get started

Override `close()` on your plugin, then close the manager when you are done with it.

```typescript
import {BasePlugin, PluginManager} from '@google/adk';

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

const pluginManager = new PluginManager([new MetricsPlugin()]);

try {
  // Drive the agent.
} finally {
  await pluginManager.close();
}
```

## The close timeout

The manager's second constructor argument bounds how long each plugin gets. It defaults to `DEFAULT_PLUGIN_CLOSE_TIMEOUT_SECONDS`, which is 5 seconds, and it applies to each plugin separately rather than to the whole shutdown.

```typescript
const pluginManager = new PluginManager([new MetricsPlugin()], 10);
```

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

The switch is checked before the first plugin, so a borrowed plugin that never finishes closing cannot delay the borrower either. It is reversible: pass `false` to close normally again.

## Failures

When one or more plugins fail, the manager still closes the rest, then rejects with an `AggregateError`. Its message names each failing plugin and its `errors` array carries the individual causes.

```typescript
try {
  await pluginManager.close();
} catch (error: unknown) {
  if (error instanceof AggregateError) {
    // error.message: Failed to close plugins: 'metrics'
    for (const cause of error.errors) {
      // cause.message: Error closing plugin 'metrics': socket still busy
    }
  }
}
```

A timed-out plugin is reported the same way, with the message `Closing plugin '<name>' timed out after <n>s.`

## Guarantees

- Every registered plugin is closed, even when an earlier one throws or times out.
- Plugins close in registration order, one at a time.
- An override must be idempotent, because a plugin registered on two managers is closed by each of them.
- `close()` does nothing at all after `setSkipClosingPlugins(true)`.
