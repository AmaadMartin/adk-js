import {LlmAgent, OpenAPIToolset, tokenToSchemeCredential} from '@google/adk';

const PETSTORE_SPEC = `
openapi: 3.0.0
info:
  title: Sample Petstore API
  version: 1.0.0
servers:
  - url: https://petstore.swagger.io/v2
paths:
  /pets:
    get:
      operationId: listPets
      summary: List all pets
      parameters:
        - name: limit
          in: query
          required: false
          schema:
            type: integer
      responses:
        '200':
          description: A paged array of pets
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: integer
                    name:
                      type: string
`;

const {authScheme, authCredential} = tokenToSchemeCredential(
  'apikey',
  'header',
  'X-API-Key',
  process.env.PETSTORE_API_KEY ?? 'demo-key',
);

export const petstoreToolset = new OpenAPIToolset({
  specStr: PETSTORE_SPEC,
  specStrType: 'yaml',
  authScheme,
  authCredential,
});

export const rootAgent = new LlmAgent({
  name: 'petstore_openapi_agent',
  model: 'gemini-2.5-flash',
  instruction: 'You help users query the Petstore REST API using OpenAPI tools.',
  tools: [petstoreToolset],
});
