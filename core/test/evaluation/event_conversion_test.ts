/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {convertEventsToEvalInvocations, createEvent, Event} from '@google/adk';
import {GroundingMetadata, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

function buildEvent(
  author: string,
  parts: Part[],
  invocationId: string,
  timestamp = 1000,
): Event {
  return createEvent({
    author,
    invocationId,
    timestamp,
    content: {role: author === 'user' ? 'user' : 'model', parts},
  });
}

function textPart(text: string): Part {
  return {text};
}

function functionCallPart(name: string): Part {
  return {functionCall: {name, args: {}}};
}

describe('convertEventsToEvalInvocations', () => {
  it('returns no invocations for an empty event list', () => {
    expect(convertEventsToEvalInvocations([])).toEqual([]);
  });

  it('converts a single turn with a text response', () => {
    const events = [
      buildEvent('user', [textPart('Hello')], 'inv1'),
      buildEvent('agent', [textPart('Hi there!')], 'inv1'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    const invocation = invocations[0];
    expect(invocation.invocationId).toBe('inv1');
    expect(invocation.userContent.parts?.[0].text).toBe('Hello');
    expect(invocation.finalResponse?.parts?.[0].text).toBe('Hi there!');
    expect(invocation.intermediateData?.invocationEvents).toHaveLength(0);
  });

  it('keeps the text response over trailing audio of the same turn', () => {
    const audioPart: Part = {
      inlineData: {mimeType: 'audio/pcm', data: 'ZmFrZS1hdWRpbw=='},
    };
    const events = [
      buildEvent('user', [textPart('Hi')], 'inv1'),
      buildEvent('agent', [textPart('Hello there.')], 'inv1'),
      buildEvent('agent', [audioPart], 'inv1'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('Hello there.');
    const intermediate = invocations[0].intermediateData?.invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate?.[0].content?.parts?.[0].inlineData?.data).toBe(
      'ZmFrZS1hdWRpbw==',
    );
  });

  it('leaves the final response absent for a turn that only calls a tool', () => {
    const events = [
      buildEvent('user', [textPart('what is the weather?')], 'inv1'),
      buildEvent('agent', [functionCallPart('get_weather')], 'inv1'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    const invocation = invocations[0];
    expect(invocation.userContent.parts?.[0].text).toBe('what is the weather?');
    expect(invocation.finalResponse).toBeUndefined();
    const intermediate = invocation.intermediateData?.invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate?.[0].author).toBe('agent');
    expect(intermediate?.[0].content?.parts?.[0].functionCall?.name).toBe(
      'get_weather',
    );
  });

  it('keeps the tool call as the only intermediate event of a tool-then-text turn', () => {
    const events = [
      buildEvent('user', [textPart('what is the weather?')], 'inv1'),
      buildEvent('agent', [functionCallPart('get_weather')], 'inv1'),
      buildEvent('agent', [textPart('It is sunny in SF.')], 'inv1'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    const invocation = invocations[0];
    expect(invocation.finalResponse?.parts?.[0].text).toBe(
      'It is sunny in SF.',
    );
    const intermediate = invocation.intermediateData?.invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate?.[0].content?.parts?.[0].functionCall?.name).toBe(
      'get_weather',
    );
  });

  it('emits one invocation per invocation id, in first-appearance order', () => {
    const events = [
      buildEvent('user', [textPart('Hello')], 'inv1'),
      buildEvent('agent', [textPart('Hi there!')], 'inv1'),
      buildEvent('user', [textPart('How are you?')], 'inv2'),
      buildEvent('agent', [textPart('I am fine.')], 'inv2'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations.map((i) => i.invocationId)).toEqual(['inv1', 'inv2']);
    expect(invocations[0].userContent.parts?.[0].text).toBe('Hello');
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('Hi there!');
    expect(invocations[1].userContent.parts?.[0].text).toBe('How are you?');
    expect(invocations[1].finalResponse?.parts?.[0].text).toBe('I am fine.');
  });

  it('records every sub-agent step of a multi-agent turn', () => {
    const events = [
      buildEvent('user', [textPart('Do something')], 'inv1'),
      buildEvent('root_agent', [functionCallPart('tool1')], 'inv1'),
      buildEvent('sub_agent_1', [functionCallPart('tool2')], 'inv1'),
      buildEvent(
        'sub_agent_1',
        [functionCallPart('tool3'), textPart('intermediate response')],
        'inv1',
      ),
      buildEvent('sub_agent_2', [functionCallPart('tool4')], 'inv1'),
      buildEvent('root_agent', [textPart('All done.')], 'inv1'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    const invocation = invocations[0];
    expect(invocation.finalResponse?.parts?.[0].text).toBe('All done.');
    const intermediate = invocation.intermediateData?.invocationEvents;
    expect(intermediate?.map((e) => e.author)).toEqual([
      'root_agent',
      'sub_agent_1',
      'sub_agent_1',
      'sub_agent_2',
    ]);
  });

  it('excludes only the chosen final event when several agents respond', () => {
    const events = [
      buildEvent('user', [textPart('Hello')], 'inv1'),
      buildEvent('agent1', [textPart('First response')], 'inv1'),
      buildEvent('agent2', [textPart('Second response')], 'inv1'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    const invocation = invocations[0];
    expect(invocation.finalResponse?.parts?.[0].text).toBe('Second response');
    const intermediate = invocation.intermediateData?.invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate?.[0].author).toBe('agent1');
    expect(intermediate?.[0].content?.parts?.[0].text).toBe('First response');
  });

  it('keeps a final event that carries a tool call', () => {
    const events = [
      buildEvent('user', [textPart('turn on the light')], 'inv1'),
      createEvent({
        author: 'agent',
        invocationId: 'inv1',
        content: {role: 'model', parts: [functionCallPart('set_light')]},
        actions: {skipSummarization: true},
      }),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    const invocation = invocations[0];
    expect(invocation.finalResponse?.parts?.[0].functionCall?.name).toBe(
      'set_light',
    );
    const intermediate = invocation.intermediateData?.invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate?.[0].content?.parts?.[0].functionCall?.name).toBe(
      'set_light',
    );
  });

  it('preserves grounding metadata from the final response', () => {
    const groundingMetadata: GroundingMetadata = {
      webSearchQueries: ['recent AI news'],
    };
    const events = [
      buildEvent('user', [textPart("What's new in AI?")], 'inv1'),
      createEvent({
        author: 'agent',
        invocationId: 'inv1',
        content: {role: 'model', parts: [textPart('Here are sources.')]},
        groundingMetadata,
      }),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    const intermediate = invocations[0].intermediateData?.invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate?.[0].content).toBeUndefined();
    expect(intermediate?.[0].groundingMetadata).toEqual(groundingMetadata);
  });

  it('keeps an event that carries grounding metadata but no content', () => {
    const groundingMetadata: GroundingMetadata = {
      webSearchQueries: ['weather in SF'],
    };
    const events = [
      buildEvent('user', [textPart('weather?')], 'inv1'),
      createEvent({author: 'agent', invocationId: 'inv1', groundingMetadata}),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    const invocation = invocations[0];
    expect(invocation.finalResponse).toBeUndefined();
    const intermediate = invocation.intermediateData?.invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate?.[0].content).toBeUndefined();
    expect(intermediate?.[0].groundingMetadata).toEqual(groundingMetadata);
  });

  it('records an event with no author as authored by the agent', () => {
    const events = [
      buildEvent('user', [textPart('Hello')], 'inv1'),
      createEvent({
        invocationId: 'inv1',
        content: {role: 'model', parts: [functionCallPart('tool1')]},
      }),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    const intermediate = invocations[0].intermediateData?.invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate?.[0].author).toBe('agent');
  });

  it('treats an author of "User" as the user', () => {
    const events = [buildEvent('User', [textPart('Hello')], 'inv1')];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations[0].userContent.parts?.[0].text).toBe('Hello');
    expect(invocations[0].intermediateData?.invocationEvents).toHaveLength(0);
  });

  it('drops an event with no content and no grounding metadata', () => {
    const events = [
      buildEvent('user', [textPart('Hello')], 'inv1'),
      createEvent({author: 'agent', invocationId: 'inv1'}),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations[0].intermediateData?.invocationEvents).toHaveLength(0);
  });

  it('drops an event whose parts carry no signal', () => {
    const events = [
      buildEvent('user', [textPart('Hello')], 'inv1'),
      buildEvent('agent', [{thought: true}], 'inv1'),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations[0].intermediateData?.invocationEvents).toHaveLength(0);
  });

  it('leaves the user content empty when a user event carries no content', () => {
    const events = [
      createEvent({author: 'user', invocationId: 'inv1', timestamp: 4242}),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations[0].userContent).toEqual({parts: []});
    expect(invocations[0].creationTimestamp).toBe(0);
  });

  it('takes the creation timestamp from the user event', () => {
    const events = [
      buildEvent('user', [textPart('Hello')], 'inv1', 1717171717000),
      buildEvent('agent', [textPart('Hi!')], 'inv1', 1717171718000),
      buildEvent('agent', [textPart('Orphan turn')], 'inv2', 1717171719000),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations[0].creationTimestamp).toBe(1717171717000);
    expect(invocations[1].creationTimestamp).toBe(0);
  });

  it('groups events that carry an empty invocation id', () => {
    const events = [
      buildEvent('user', [textPart('Hello')], ''),
      buildEvent('agent', [textPart('Hi!')], ''),
    ];

    const invocations = convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    expect(invocations[0].invocationId).toBe('');
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('Hi!');
  });

  it('does not mutate the input events', () => {
    const events = [
      buildEvent('user', [textPart('Hello')], 'inv1'),
      buildEvent('agent', [functionCallPart('tool1')], 'inv1'),
      buildEvent('agent', [textPart('Done.')], 'inv1'),
    ];
    const snapshot = JSON.stringify(events);

    convertEventsToEvalInvocations(events);

    expect(JSON.stringify(events)).toBe(snapshot);
  });
});
