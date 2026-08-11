/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event, InvocationContext} from '@google/adk';
import {BaseAgent, createEvent} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createRunner} from './test_case_utils.js';

const AGENT_NAME = 'run_config_echo';

/**
 * Emits the `maxLlmCalls` the runner resolved for the invocation, which is how
 * a test sees which run config reached `runAsync`.
 */
class RunConfigEchoAgent extends BaseAgent {
  constructor() {
    super({name: AGENT_NAME});
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: String(ctx.runConfig?.maxLlmCalls)}],
      },
    });
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Not supported');
  }
}

async function echoedMaxLlmCalls(
  events: AsyncGenerator<Event, void, undefined>,
): Promise<string[]> {
  const texts: string[] = [];
  for await (const event of events) {
    const text = event.content?.parts?.[0]?.text;
    if (event.author === AGENT_NAME && text) {
      texts.push(text);
    }
  }
  return texts;
}

describe('createRunner', () => {
  it('forwards the runConfig to runAsync', async () => {
    const {run} = await createRunner(new RunConfigEchoAgent(), [], {
      maxLlmCalls: 7,
    });

    expect(await echoedMaxLlmCalls(run('hi'))).toEqual(['7']);
  });

  it('applies the default runConfig when none is given', async () => {
    const {run} = await createRunner(new RunConfigEchoAgent());

    expect(await echoedMaxLlmCalls(run('hi'))).toEqual(['500']);
  });
});
