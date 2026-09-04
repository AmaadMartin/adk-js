# Run error notifications

`BasePlugin.onRunErrorCallback` tells a plugin that an error escaped a run. Reach for it when a plugin ships crash telemetry, or writes an audit trail that must record failures as well as successes.

## Introduction

Most plugin callbacks can change what happens next. `onModelErrorCallback` may return a replacement response, and `onToolErrorCallback` may return a replacement tool result; the manager stops at the first plugin that returns a value.

`onRunErrorCallback` is different. It reports an error that has already happened and that the caller is about to propagate, so there is nothing left to decide. The manager therefore ignores what the plugin returns, notifies every plugin, and never rejects. A plugin that fails while reporting the error is logged and skipped, because a broken reporter must not replace the error being reported.

Use `onRunErrorCallback` to observe a failed run. Use `onToolErrorCallback` or `onModelErrorCallback` when you want to recover from a narrower failure rather than observe it.

## Get started

Override the hook, register the plugin, and call the manager from wherever you catch a run failure.

```typescript
import {BasePlugin, InvocationContext, PluginManager} from '@google/adk';

class CrashReportingPlugin extends BasePlugin {
  constructor() {
    super('crash_reporting');
  }

  override async onRunErrorCallback({
    invocationContext,
    error,
  }: {
    invocationContext: InvocationContext;
    error: Error;
  }): Promise<void> {
    await this.report(invocationContext.invocationId, error);
  }

  private async report(invocationId: string, error: Error): Promise<void> {
    // Send the failure to your crash reporting backend.
  }
}

const pluginManager = new PluginManager([new CrashReportingPlugin()]);

async function runAndReport(
  invocationContext: InvocationContext,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof Error) {
      await pluginManager.runOnRunErrorCallback({invocationContext, error});
    }
    throw error;
  }
}
```

`runOnRunErrorCallback` never rejects, so the `throw` still propagates the original error.

## Guarantees

- Every registered plugin is notified, in registration order.
- `runOnRunErrorCallback` always resolves. It never rejects, even when every plugin throws.
- A plugin that throws is logged at error level and does not stop the plugins after it.
- The value a plugin returns is ignored. The hook resolves to `void`, so TypeScript rejects a plugin that tries to return one.
