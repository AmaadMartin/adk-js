/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The transcript, instructions and tool declarations a multi-turn judge prompt
 * carries, built from a conversation.
 */

import {
  Invocation,
  InvocationEvents,
  assembleDialogueHistory,
} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createInvocation(userText: string, agentText: string): Invocation {
  return {
    userContent: {parts: [{text: userText}]},
    finalResponse: {parts: [{text: agentText}]},
  };
}

/** A three-turn booking conversation. */
function createConversation(): Invocation[] {
  return [
    createInvocation('Find me a flight to Tokyo.', 'I found three flights.'),
    createInvocation('Book the first one.', 'Please confirm the $800 fare.'),
    createInvocation('Confirmed.', 'Booked, your code is ABC123.'),
  ];
}

describe('assembleDialogueHistory transcript', () => {
  it('joins the text parts of one turn with a single space', () => {
    const {dialogue} = assembleDialogueHistory([
      {
        userContent: {parts: [{text: 'Book a flight'}, {text: 'to Tokyo.'}]},
        finalResponse: {parts: [{text: 'Searching'}, {text: 'now.'}]},
      },
    ]);

    expect(dialogue).toBe(
      'USER TURN 1: Book a flight to Tokyo.\n' +
        'AGENT (agent) TURN 1: Searching now.',
    );
  });

  it('renders an empty payload for a call and a response that carry none', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {
          author: 'booking_agent',
          content: {
            parts: [
              {text: 'Listing the airports.'},
              {functionCall: {name: 'list_airports'}},
              {functionResponse: {name: 'list_airports'}},
            ],
          },
        },
      ],
    };

    const {dialogue} = assembleDialogueHistory([
      {userContent: {parts: []}, intermediateData},
    ]);

    expect(dialogue).toBe(
      'AGENT (booking_agent) TURN 1: Listing the airports.\n' +
        'AGENT (booking_agent) TURN 1 (tool call): list_airports({})\n' +
        'AGENT (booking_agent) TURN 1 (tool output): list_airports -> {}',
    );
  });

  it('renders a mixed-case user author as a USER turn', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {author: 'User', content: {parts: [{text: 'Actually, Osaka.'}]}},
      ],
    };

    const {dialogue} = assembleDialogueHistory([
      {userContent: {parts: []}, intermediateData},
    ]);

    expect(dialogue).toBe('USER TURN 1: Actually, Osaka.');
  });

  it('skips an event that carries no content', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [{author: 'booking_agent'}],
    };

    const {dialogue} = assembleDialogueHistory([
      {
        userContent: {parts: [{text: 'Book it.'}]},
        finalResponse: {parts: [{text: 'Booked.'}]},
        intermediateData,
      },
    ]);

    expect(dialogue).toBe(
      'USER TURN 1: Book it.\nAGENT (booking_agent) TURN 1: Booked.',
    );
  });

  it('names the final agent turn `agent` when no event was recorded', () => {
    const {dialogue} = assembleDialogueHistory([
      {
        userContent: {parts: [{text: 'Book it.'}]},
        finalResponse: {parts: [{text: 'Booked.'}]},
        intermediateData: {invocationEvents: []},
      },
    ]);

    expect(dialogue).toBe(
      'USER TURN 1: Book it.\nAGENT (agent) TURN 1: Booked.',
    );
  });

  it('names the final agent turn after the first event author', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {author: 'booking_agent', content: {parts: [{text: 'Working.'}]}},
        {author: 'payment_agent', content: {parts: [{text: 'Charging.'}]}},
      ],
    };

    const {dialogue} = assembleDialogueHistory([
      {
        userContent: {parts: [{text: 'Book it.'}]},
        finalResponse: {parts: [{text: 'Booked.'}]},
        intermediateData,
      },
    ]);

    expect(dialogue).toBe(
      'USER TURN 1: Book it.\n' +
        'AGENT (booking_agent) TURN 1: Working.\n' +
        'AGENT (payment_agent) TURN 1: Charging.\n' +
        'AGENT (booking_agent) TURN 1: Booked.',
    );
  });

  it('ignores a recorded trajectory, which carries no events', () => {
    const {dialogue} = assembleDialogueHistory([
      {
        userContent: {parts: [{text: 'Book it.'}]},
        finalResponse: {parts: [{text: 'Booked.'}]},
        intermediateData: {
          toolUses: [{name: 'book_flight', args: {flight: 'NH7'}}],
          toolResponses: [{name: 'book_flight', response: {code: 'ABC123'}}],
          intermediateResponses: [],
        },
      },
    ]);

    expect(dialogue).toBe(
      'USER TURN 1: Book it.\nAGENT (agent) TURN 1: Booked.',
    );
  });
});

describe('assembleDialogueHistory instructions and tools', () => {
  const tool: Tool = {
    functionDeclarations: [
      {name: 'search_flights', description: 'Search for flights.'},
    ],
  };

  it('de-duplicates the agent details repeated across turns', () => {
    const appDetails = {
      agentDetails: {
        booking_agent: {
          name: 'booking_agent',
          instructions: 'You book flights.',
          toolDeclarations: [tool],
        },
      },
    };
    const conversation = createConversation().map((invocation) => ({
      ...invocation,
      appDetails,
    }));

    const {instructions, tools} = assembleDialogueHistory(conversation);

    expect(instructions).toBe(
      'Agent booking_agent Instructions:\nYou book flights.',
    );
    expect(tools).toBe(
      'Agent: booking_agent\n- search_flights: Search for flights.',
    );
  });

  it('renders an agent that declares no instructions and no tool functions', () => {
    const {instructions, tools} = assembleDialogueHistory([
      {
        userContent: {parts: [{text: 'Hello.'}]},
        appDetails: {
          agentDetails: {
            quiet_agent: {name: 'quiet_agent', toolDeclarations: [{}]},
          },
        },
      },
    ]);

    expect(instructions).toBe('Agent quiet_agent Instructions:\n');
    expect(tools).toBe('Agent: quiet_agent');
  });

  it('renders an agent that declares no tools at all', () => {
    const {instructions, tools} = assembleDialogueHistory([
      {
        userContent: {parts: [{text: 'Hello.'}]},
        appDetails: {
          agentDetails: {
            chat_agent: {name: 'chat_agent', instructions: 'You chat.'},
          },
        },
      },
    ]);

    expect(instructions).toBe('Agent chat_agent Instructions:\nYou chat.');
    expect(tools).toBe('Agent: chat_agent');
  });

  it('reports no instructions and no tools when no turn carries appDetails', () => {
    const {instructions, tools} = assembleDialogueHistory(createConversation());

    expect(instructions).toBe('');
    expect(tools).toBe('');
  });
});
