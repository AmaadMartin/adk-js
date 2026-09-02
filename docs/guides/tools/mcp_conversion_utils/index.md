# adkToMcpToolType and geminiToJsonSchema

Convert an ADK tool into an MCP tool descriptor, so an MCP server can advertise
ADK tools to any MCP host. Reach for these when you write the server side of
the Model Context Protocol.

## Introduction

Everything else MCP in ADK runs the other way. `MCPTool` and `MCPToolset`
consume a remote MCP server: they read a server's tool list and present each
tool to the model as an ADK tool. These two functions run the ADK to MCP
direction. You keep your tools in ADK, and you publish them over MCP.

ADK has a second genai-to-JSON-Schema converter, `genaiSchemaToJsonSchema` in
`core/src/utils/genai_schema_to_json.ts`. Choosing between them is the one
thing worth knowing before you start. It answers to a different contract: its
output builds a Zod validator, so it widens `nullable: true` into a
`['string', 'null']` type union and drops `format: 'enum'` and `example`. Use
that one to validate a value. Use `geminiToJsonSchema` to describe a tool to an
MCP client.

## Get started

Declare a tool as usual, then convert it.

```typescript
import {FunctionTool, adkToMcpToolType} from '@google/adk';
import {z} from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the current weather for a city.',
  parameters: z.object({
    city: z.string().describe('The city to report on.'),
    units: z.enum(['metric', 'imperial']).optional(),
  }),
  execute: ({city}) => `It is sunny in ${city}.`,
});

const descriptor = adkToMcpToolType(getWeather);
```

`descriptor` is:

```json
{
  "name": "get_weather",
  "description": "Returns the current weather for a city.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "city": {"type": "string", "description": "The city to report on."},
      "units": {"type": "string", "enum": ["metric", "imperial"]}
    },
    "required": ["city"]
  }
}
```

`@modelcontextprotocol/sdk` is an optional peer dependency of `@google/adk`.
Install it to serve the descriptor from a `tools/list` handler.

## Schema mapping

| Source                                                         | Result                                        |
| -------------------------------------------------------------- | --------------------------------------------- |
| `type: Type.STRING`                                            | `type: 'string'` — the enum name, lower-cased |
| no `type`, or `Type.TYPE_UNSPECIFIED`                          | `type: 'null'`                                |
| `nullable: true`                                               | `nullable: true`, and `type` is left alone    |
| `nullable: false`                                              | nothing                                       |
| `title`, `description`, `default`, `enum`, `format`, `example` | copied under the same name                    |
| `pattern`, `minLength`, `maxLength`                            | kept only on a `STRING` schema                |
| `minimum`, `maximum`                                           | kept only on a `NUMBER` or `INTEGER` schema   |
| `items`, `minItems`, `maxItems`                                | kept only on an `ARRAY` schema                |
| `properties`, `required`, `minProperties`, `maxProperties`     | kept only on an `OBJECT` schema               |
| `anyOf`                                                        | converted, whatever the `type`                |
| `propertyOrdering`                                             | dropped — it has no JSON Schema meaning       |

The bounds that genai stringifies become numbers, because JSON Schema requires
numbers. `items`, `properties` and `anyOf` are converted recursively. A
constraint that does not match the declared type is dropped, not passed
through: `{type: INTEGER, minLength: '2', minimum: 1}` becomes
`{type: 'integer', minimum: 1}`.
