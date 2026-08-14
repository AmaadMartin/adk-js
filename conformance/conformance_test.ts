/**
 * Conformance: does adk-js orchestrate a model response the way adk-python does?
 *
 * Fixtures are recorded from adk-python's own test suite at the Runner
 * boundary. Each carries the user message, the model responses the Python
 * runtime reacted to, the results its tools returned, and the events it
 * emitted.
 *
 * Each replayable fixture is REPLAYED here: an LlmAgent is built with a
 * scripted model that yields the recorded responses in order and stub tools
 * that replay the recorded results, then the resulting event stream is
 * compared against what Python emitted.
 *
 * This does not test the model. It tests what the runtime does WITH a model
 * response: which events it emits, their authors and order, and the tools it
 * dispatches. That is the behaviour two SDKs must agree on to be at parity,
 * and it is precisely what a ported unit test asserting Python's internal
 * call graph would not check.
 */
import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {BaseLlm, FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import type {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import fixtures from './fixtures.json' with {type: 'json'};

interface Fixture {
  id: string;
  agent: string;
  agentName: string;
  newMessage: Content;
  /** Model responses grouped by the call that produced them. */
  modelScript: Content[][];
  expectedEvents: Array<Record<string, unknown>>;
  toolResponses: Record<string, unknown[]>;
  expectsError?: {type: string; msg: string} | null;
  replayable: boolean;
  skipReason: string;
}

/** A model that says exactly what the model said when the trace was recorded. */
class ScriptedLlm extends BaseLlm {
  private call = 0;

  constructor(private readonly script: Content[][]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    // One CALL yields the whole group. adk-python's mocks return several
    // responses from a single call, and handing them back one per call ends
    // the agent loop early -- which then looks exactly like adk-js dropping
    // turns.
    const group = this.script[this.call++];
    if (!group) {
      // Past the end of the script the recorded conversation is over. An
      // exhausted adk-python mock returns a response with no parts, so this
      // returns the same thing: a text part here would be a turn the recording
      // never contained, and the comparison would report the harness's own
      // invention as a divergence.
      yield {content: {role: 'model', parts: []}};
      return;
    }
    for (const content of group) {
      yield {content};
    }
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('conformance fixtures do not exercise live connections');
  }
}

/**
 * Stub tools that replay what the real tools returned.
 *
 * The point is not to test the tool. It is to feed the runtime the same tool
 * result Python's runtime saw, so any difference in the event stream is the
 * runtime's doing and not the tool's.
 */
function replayTools(f: Fixture): FunctionTool[] {
  return Object.entries(f.toolResponses).map(([name, responses]) => {
    let call = 0;
    return new FunctionTool({
      name,
      description: `Replays the recorded result of ${name}.`,
      execute: () => responses[Math.min(call++, responses.length - 1)],
    });
  });
}

/**
 * The shape of a turn: who spoke and what kind of part it was.
 *
 * Contentless events are dropped first. adk-python closes an invocation with a
 * bookkeeping event carrying no content and `endOfAgent` on its actions, and
 * adk-js has no equivalent. That is a real difference, but it is one known
 * difference: left in, it fails every multi-turn fixture for the same reason
 * and buries the divergences worth reading. It is recorded in the README
 * instead of being asserted 85 times.
 */
function envelope(events: Array<Record<string, unknown>>) {
  return events
    .filter((e) => {
      const c = (e.content ?? {}) as Record<string, unknown>;
      return ((c.parts ?? []) as unknown[]).length > 0;
    })
    .map((e) => {
      const c = (e.content ?? {}) as Record<string, unknown>;
      const parts = (c.parts ?? []) as Array<Record<string, unknown>>;
      return {
        author: e.author,
        role: c.role,
        partKinds: parts
          .map((p) =>
            Object.keys(p)
              .filter((k) => p[k] != null)
              .sort()
              .join('+'),
          )
          .filter((k) => k !== ''),
      };
    });
}

/** Tool dispatch, in order: the strongest claim the trace supports. */
function toolCalls(events: Array<Record<string, unknown>>): string[] {
  const names: string[] = [];
  for (const e of events) {
    const c = (e.content ?? {}) as Record<string, unknown>;
    for (const p of (c.parts ?? []) as Array<Record<string, unknown>>) {
      const fc = p.functionCall as {name?: string} | undefined;
      if (fc?.name) names.push(fc.name);
    }
  }
  return names;
}

/** Run one fixture through adk-js and return what it emitted. */
async function replay(f: Fixture): Promise<Array<Record<string, unknown>>> {
  const agent = new LlmAgent({
    name: f.agentName,
    model: new ScriptedLlm(f.modelScript),
    tools: replayTools(f),
  });
  const runner = new InMemoryRunner({agent, appName: 'conformance'});
  const out: Array<Record<string, unknown>> = [];
  for await (const event of runner.runEphemeral({
    userId: 'conformance_user',
    newMessage: f.newMessage,
  })) {
    out.push(event as unknown as Record<string, unknown>);
  }
  return out;
}

const all = fixtures as unknown as Fixture[];
const replayable = all.filter((f) => f.replayable);

describe('adk-python conformance', () => {
  it('has fixtures to replay', () => {
    expect(replayable.length).toBeGreaterThan(0);
  });

  for (const f of replayable) {
    it(`[${f.agentName}] ${f.id} emits the same turn shape`, async () => {
      const actual = await replay(f);
      // Envelope, not a deep equality. It fails when the runtimes genuinely
      // disagree about what happened -- a missing tool-response event, a
      // reordered turn, the wrong author -- while surviving the harmless
      // divergence in optional metadata that would otherwise flag all 85
      // fixtures on day one and get the suite ignored by the end of it.
      expect(envelope(actual)).toEqual(envelope(f.expectedEvents));
    });

    if (Object.keys(f.toolResponses).length > 0) {
      it(`[${f.agentName}] ${f.id} dispatches the same tools`, async () => {
        const actual = await replay(f);
        expect(toolCalls(actual)).toEqual(toolCalls(f.expectedEvents));
      });
    }
  }

  // Held fixtures are named, not hidden. Each reason is a gap worth closing,
  // and a silent drop would inflate the parity number instead.
  describe('held', () => {
    for (const f of all.filter((x) => !x.replayable)) {
      it.skip(`${f.id}: ${f.skipReason}`, () => {});
    }
  });
});
