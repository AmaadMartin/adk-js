/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AutoTracingPlugin
 * ../../../docs/guides/plugins/auto_tracing/index.md
 *
 * Prints one OpenTelemetry span per function the agent reaches, each carrying
 * the call's arguments and its result as `adk.fn.*` attributes.
 *
 * Run (needs a model key):
 *   npm run sample -- samples/plugins/auto_tracing/agent.ts
 *
 * Ask about Paris. The console exporter prints a `lookupCity` span and,
 * nested under it, a `format` span. The names are bare because `cityFacts` is
 * a plain object; a method on a class prototype is named `Owner.method`.
 *
 * `cityFacts` is passed as an `extraTarget` because the agent graph does not
 * reach it: the tool closes over it, and a closure is not walkable.
 */

import {
  App,
  AutoTracingPlugin,
  FunctionTool,
  LlmAgent,
  maybeSetOtelProviders,
} from '@google/adk';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {z} from 'zod';

// The plugin asks the tracer whether it records when it is constructed, so
// the provider has to be registered before the plugin is created.
maybeSetOtelProviders([
  {spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())]},
]);

const POPULATIONS: Record<string, number> = {
  paris: 2_100_000,
  tokyo: 13_900_000,
};

const cityFacts = {
  lookupCity(city: string): string {
    return cityFacts.format(city, POPULATIONS[city.toLowerCase()] ?? 0);
  },
  format(city: string, population: number): string {
    return `${city} has about ${population.toLocaleString('en-US')} residents`;
  },
};

const lookupCity = new FunctionTool({
  name: 'lookup_city',
  description: 'Returns the population of a city.',
  parameters: z.object({city: z.string()}),
  execute: async ({city}) => ({summary: cityFacts.lookupCity(city)}),
});

const agent = new LlmAgent({
  name: 'auto_tracing_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about cities by calling lookup_city.',
  tools: [lookupCity],
});

export const app = new App({
  name: 'auto_tracing',
  rootAgent: agent,
  plugins: [new AutoTracingPlugin({extraTargets: [cityFacts]})],
});
