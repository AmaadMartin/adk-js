/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AutoTracingPlugin: spans for the functions your own agent code runs.
 *
 * The agent below runs a tool, and the tool calls two helpers of its own. All
 * of them are reachable from the agent, so the plugin wraps them and each call
 * prints an `adk.fn.*` span. The `apiKey` argument never reaches a span,
 * because its name marks it as a secret.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/plugins/auto_tracing/agent.ts
 */

import {
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {z} from 'zod';

import {
  App,
  AutoTracingPlugin,
  BaseAgent,
  createEvent,
  Event,
  FunctionTool,
  InvocationContext,
} from '@google/adk';

// Print every span this process finishes, so a run shows the plugin's output.
new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
}).register();

/** Helpers the tool calls. The plugin reaches them through the tool. */
class Rates {
  private readonly table: ReadonlyMap<string, number> = new Map([
    ['EUR', 0.92],
    ['GBP', 0.79],
  ]);

  lookup(currency: string): number {
    return this.table.get(currency) ?? 1;
  }

  round(amount: number): number {
    return Math.round(amount * 100) / 100;
  }
}

const conversionInput = z.object({
  amount: z.number(),
  currency: z.string(),
  apiKey: z.string(),
});

const rates = new Rates();

const convertTool = new FunctionTool({
  name: 'convert',
  description: 'Converts an amount from US dollars into another currency.',
  parameters: conversionInput,
  execute: ({amount, currency, apiKey}) => {
    void apiKey;
    return rates.round(amount * rates.lookup(currency));
  },
});

/**
 * A plain agent, so the sample runs with no model and no credentials. The
 * plugin instruments whatever the agent can reach either way.
 */
class ConversionAgent extends BaseAgent {
  constructor(
    readonly toolbox: {
      convert: FunctionTool<typeof conversionInput>;
      rates: Rates;
    },
  ) {
    super({name: 'conversion_agent', description: 'Converts a fixed amount.'});
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const {rates: table} = this.toolbox;
    const total = table.round(42 * table.lookup('EUR'));
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      content: {role: 'model', parts: [{text: `42 USD is ${total} EUR`}]},
      output: total,
    });
  }

  // eslint-disable-next-line require-yield -- BaseAgent mandates an AsyncGenerator; this sample has no live path.
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

export const rootAgent = new ConversionAgent({convert: convertTool, rates});

export const app = new App({
  name: 'auto_tracing',
  rootAgent,
  plugins: [
    // The agent graph reaches the whole framework, so the default 4096-char
    // cap fills a console. 200 keeps a run readable.
    new AutoTracingPlugin({maxReprLen: 200}),
  ],
});
