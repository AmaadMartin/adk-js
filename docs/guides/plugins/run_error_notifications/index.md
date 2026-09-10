# Run error notifications

`BasePlugin.onRunErrorCallback` tells a plugin that an invocation failed. Reach for it when a plugin records or exports what happened during a run, and must see the failures as well as the successes.

## Introduction

A plugin sees a healthy invocation through `beforeRunCallback` and `afterRunCallback`. It sees nothing when the invocation throws, because the error travels straight to the caller and `afterRunCallback` never runs. A telemetry plugin that only counts the successes therefore reports a run that crashed as a run that never ended.

`onRunErrorCallback` closes that gap. It is a notification: the manager passes the error to every registered plugin and then the caller propagates the original error, so a plugin can record a failure but cannot swallow one. `PluginManager.runOnRunErrorCallback` drives the fan-out, and the component that catches the error calls it — ADK does not notify the plugins on your behalf.

The hook is the invocation-level counterpart of `onModelErrorCallback` and `onToolErrorCallback`. Those two can return a replacement result and recover the turn. This one cannot return anything.

## Get started

Override the hook on your plugin.

```typescript
import {BasePlugin, InvocationContext} from '@google/adk';

class FailureReporter extends BasePlugin {
  constructor() {
    super('failure_reporter');
  }

  override async onRunErrorCallback({
    invocationContext,
    error,
  }: {
    invocationContext: InvocationContext;
    error: Error;
  }): Promise<void> {
    // Report invocationContext.invocationId and error.message to your
    // observability backend.
  }
}
```

Then notify the plugins from the code that catches the error. Any component holding an `InvocationContext` reaches the manager through it.

```typescript
try {
  // Run the invocation.
} catch (error: unknown) {
  await invocationContext.pluginManager.runOnRunErrorCallback({
    invocationContext,
    error: error instanceof Error ? error : new Error(String(error)),
  });
  throw error;
}
```

## Guarantees

- Every registered plugin is notified, in registration order.
- A plugin that throws is logged at error level, and the next plugin still runs.
- `runOnRunErrorCallback` always resolves. It never rejects, so it cannot replace the error the caller is about to propagate.
- The default hook does nothing, so an existing plugin needs no change.
