/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DiscoveryDocument} from '@google/adk';

/**
 * A trimmed Google Calendar v3 Discovery document, ported from the adk-python
 * `calendar_api_spec` fixture.
 */
export const CALENDAR_DISCOVERY_DOCUMENT: DiscoveryDocument = {
  title: 'Google Calendar API',
  description: 'Accesses the Google Calendar API',
  version: 'v3',
  documentationLink: 'https://developers.google.com/calendar/',
  rootUrl: 'https://www.googleapis.com/',
  servicePath: 'calendar/v3/',
  auth: {
    oauth2: {
      scopes: {
        'https://www.googleapis.com/auth/calendar': {
          description: 'Full access to Google Calendar',
        },
        'https://www.googleapis.com/auth/calendar.readonly': {
          description: 'Read-only access to Google Calendar',
        },
      },
    },
  },
  schemas: {
    Calendar: {
      type: 'object',
      description: 'A calendar resource',
      properties: {
        id: {type: 'string', description: 'Calendar identifier'},
        summary: {
          type: 'string',
          description: 'Calendar summary',
          required: true,
        },
        timeZone: {type: 'string', description: 'Calendar timezone'},
      },
    },
    Event: {
      type: 'object',
      description: 'An event resource',
      properties: {
        id: {type: 'string', description: 'Event identifier'},
        summary: {type: 'string', description: 'Event summary'},
        start: {$ref: 'EventDateTime'},
        end: {$ref: 'EventDateTime'},
        attendees: {
          type: 'array',
          description: 'Event attendees',
          items: {$ref: 'EventAttendee'},
        },
      },
    },
    EventDateTime: {
      type: 'object',
      description: 'Date/time for an event',
      properties: {
        dateTime: {
          type: 'string',
          format: 'date-time',
          description: 'Date/time in RFC3339 format',
        },
        timeZone: {type: 'string', description: 'Timezone for the date/time'},
      },
    },
    EventAttendee: {
      type: 'object',
      description: 'An attendee of an event',
      properties: {
        email: {type: 'string', description: 'Attendee email'},
        responseStatus: {
          type: 'string',
          description: 'Response status',
          enum: ['needsAction', 'declined', 'tentative', 'accepted'],
        },
      },
    },
  },
  resources: {
    calendars: {
      methods: {
        get: {
          id: 'calendar.calendars.get',
          flatPath: 'calendars/{calendarId}',
          httpMethod: 'GET',
          description: 'Returns metadata for a calendar.',
          parameters: {
            calendarId: {
              type: 'string',
              description: 'Calendar identifier',
              required: true,
              location: 'path',
            },
          },
          response: {$ref: 'Calendar'},
          scopes: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/calendar.readonly',
          ],
        },
        insert: {
          id: 'calendar.calendars.insert',
          path: 'calendars',
          httpMethod: 'POST',
          description: 'Creates a secondary calendar.',
          request: {$ref: 'Calendar'},
          response: {$ref: 'Calendar'},
          scopes: ['https://www.googleapis.com/auth/calendar'],
        },
      },
      resources: {
        events: {
          methods: {
            list: {
              id: 'calendar.events.list',
              flatPath: 'calendars/{calendarId}/events',
              httpMethod: 'GET',
              description: 'Returns events on the specified calendar.',
              parameters: {
                calendarId: {
                  type: 'string',
                  description: 'Calendar identifier',
                  required: true,
                  location: 'path',
                },
                maxResults: {
                  type: 'integer',
                  description: 'Maximum number of events returned',
                  format: 'int32',
                  default: '250',
                  location: 'query',
                },
                orderBy: {
                  type: 'string',
                  description: 'Order of the events returned',
                  enum: ['startTime', 'updated'],
                  location: 'query',
                },
              },
              response: {$ref: 'Events'},
              scopes: [
                'https://www.googleapis.com/auth/calendar',
                'https://www.googleapis.com/auth/calendar.readonly',
              ],
            },
          },
        },
      },
    },
  },
};

/**
 * A trimmed Google Docs v1 Discovery document, ported from the adk-python
 * `docs_api_spec` fixture. It carries the `{documentId}:batchUpdate` path
 * whose trailing verb hides the placeholder from path-parameter extraction.
 */
export const DOCS_DISCOVERY_DOCUMENT: DiscoveryDocument = {
  title: 'Google Docs API',
  description: 'Reads and writes Google Docs documents.',
  version: 'v1',
  documentationLink: 'https://developers.google.com/docs/',
  rootUrl: 'https://docs.googleapis.com/',
  servicePath: '',
  auth: {
    oauth2: {
      scopes: {
        'https://www.googleapis.com/auth/documents': {
          description:
            'See, edit, create, and delete all of your Google Docs documents',
        },
        'https://www.googleapis.com/auth/documents.readonly': {
          description: 'View your Google Docs documents',
        },
        'https://www.googleapis.com/auth/drive': {
          description:
            'See, edit, create, and delete all of your Google Drive files',
        },
        'https://www.googleapis.com/auth/drive.file': {
          description:
            'View and manage Google Drive files and folders that you have ' +
            'opened or created with this app',
        },
      },
    },
  },
  schemas: {
    Document: {
      type: 'object',
      description: 'A Google Docs document',
      properties: {
        documentId: {type: 'string', description: 'The ID of the document'},
        title: {type: 'string', description: 'The title of the document'},
        body: {$ref: 'Body', description: 'The document body'},
        revisionId: {
          type: 'string',
          description: 'The revision ID of the document',
        },
      },
    },
    Body: {
      type: 'object',
      description: 'The document body',
      properties: {
        content: {
          type: 'array',
          description: 'The content of the body',
          items: {$ref: 'StructuralElement'},
        },
      },
    },
    StructuralElement: {
      type: 'object',
      description: 'A structural element of a document',
      properties: {
        startIndex: {
          type: 'integer',
          description: 'The zero-based start index',
        },
        endIndex: {type: 'integer', description: 'The zero-based end index'},
      },
    },
    BatchUpdateDocumentRequest: {
      type: 'object',
      description: 'Request to batch update a document',
      properties: {
        requests: {
          type: 'array',
          description: 'A list of updates to apply to the document',
          items: {$ref: 'Request'},
        },
        writeControl: {
          $ref: 'WriteControl',
          description: 'Provides control over how write requests are executed',
        },
      },
    },
    Request: {
      type: 'object',
      description: 'A single kind of update to apply to a document',
      properties: {
        insertText: {$ref: 'InsertTextRequest'},
        updateTextStyle: {$ref: 'UpdateTextStyleRequest'},
        replaceAllText: {$ref: 'ReplaceAllTextRequest'},
      },
    },
    InsertTextRequest: {
      type: 'object',
      description: 'Inserts text into the document',
      properties: {
        location: {
          $ref: 'Location',
          description: 'The location to insert text',
        },
        text: {type: 'string', description: 'The text to insert'},
      },
    },
    UpdateTextStyleRequest: {
      type: 'object',
      description: 'Updates the text style of the specified range',
      properties: {
        range: {$ref: 'Range', description: 'The range to update'},
        textStyle: {$ref: 'TextStyle', description: 'The text style to apply'},
        fields: {
          type: 'string',
          description: 'The fields that should be updated',
        },
      },
    },
    ReplaceAllTextRequest: {
      type: 'object',
      description: 'Replaces all instances of text matching criteria',
      properties: {
        containsText: {$ref: 'SubstringMatchCriteria'},
        replaceText: {
          type: 'string',
          description: 'The text that will replace the matched text',
        },
      },
    },
    Location: {
      type: 'object',
      description: 'A particular location in the document',
      properties: {
        index: {type: 'integer', description: 'The zero-based index'},
        tabId: {type: 'string', description: 'The tab the location is in'},
      },
    },
    Range: {
      type: 'object',
      description: 'Specifies a contiguous range of text',
      properties: {
        startIndex: {
          type: 'integer',
          description: 'The zero-based start index',
        },
        endIndex: {type: 'integer', description: 'The zero-based end index'},
      },
    },
    TextStyle: {
      type: 'object',
      description: 'Represents the styling that can be applied to text',
      properties: {
        bold: {type: 'boolean', description: 'Whether or not the text is bold'},
        italic: {
          type: 'boolean',
          description: 'Whether or not the text is italic',
        },
        fontSize: {
          $ref: 'Dimension',
          description: "The size of the text's font",
        },
      },
    },
    SubstringMatchCriteria: {
      type: 'object',
      description:
        'A criteria that matches a specific string of text in the document',
      properties: {
        text: {type: 'string', description: 'The text to search for'},
        matchCase: {
          type: 'boolean',
          description: 'Indicates whether the search should respect case',
        },
      },
    },
    WriteControl: {
      type: 'object',
      description: 'Provides control over how write requests are executed',
      properties: {
        requiredRevisionId: {
          type: 'string',
          description: 'The required revision ID',
        },
        targetRevisionId: {
          type: 'string',
          description: 'The target revision ID',
        },
      },
    },
    BatchUpdateDocumentResponse: {
      type: 'object',
      description: 'Response from a BatchUpdateDocument request',
      properties: {
        documentId: {type: 'string', description: 'The ID of the document'},
        replies: {
          type: 'array',
          description: 'The reply of the updates',
          items: {$ref: 'Response'},
        },
        writeControl: {
          $ref: 'WriteControl',
          description: 'The updated write control',
        },
      },
    },
    Response: {
      type: 'object',
      description: 'A single response from an update',
      properties: {
        replaceAllText: {$ref: 'ReplaceAllTextResponse'},
      },
    },
    ReplaceAllTextResponse: {
      type: 'object',
      description: 'The result of replacing text',
      properties: {
        occurrencesChanged: {
          type: 'integer',
          description: 'The number of occurrences changed',
        },
      },
    },
  },
  resources: {
    documents: {
      methods: {
        get: {
          id: 'docs.documents.get',
          path: 'v1/documents/{documentId}',
          flatPath: 'v1/documents/{documentId}',
          httpMethod: 'GET',
          description: 'Gets the latest version of the specified document.',
          parameters: {
            documentId: {
              type: 'string',
              description: 'The ID of the document to retrieve',
              required: true,
              location: 'path',
            },
          },
          response: {$ref: 'Document'},
          scopes: [
            'https://www.googleapis.com/auth/documents',
            'https://www.googleapis.com/auth/documents.readonly',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/drive.file',
          ],
        },
        create: {
          id: 'docs.documents.create',
          path: 'v1/documents',
          httpMethod: 'POST',
          description:
            'Creates a blank document using the title given in the request.',
          request: {$ref: 'Document'},
          response: {$ref: 'Document'},
          scopes: [
            'https://www.googleapis.com/auth/documents',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/drive.file',
          ],
        },
        batchUpdate: {
          id: 'docs.documents.batchUpdate',
          path: 'v1/documents/{documentId}:batchUpdate',
          flatPath: 'v1/documents/{documentId}:batchUpdate',
          httpMethod: 'POST',
          description: 'Applies one or more updates to the document.',
          parameters: {
            documentId: {
              type: 'string',
              description: 'The ID of the document to update',
              required: true,
              location: 'path',
            },
          },
          request: {$ref: 'BatchUpdateDocumentRequest'},
          response: {$ref: 'BatchUpdateDocumentResponse'},
          scopes: [
            'https://www.googleapis.com/auth/documents',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/drive.file',
          ],
        },
      },
    },
  },
};
