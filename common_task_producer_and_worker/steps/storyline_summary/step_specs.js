/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */

// NOTE that each spec may be run in its own process
//      therefore no sharing of state possible

import _ from 'underscore';

const newsItem2SummarizationDocument = newsItem => (
  {
    id: newsItem.id,
    instances: [
      {
        title: newsItem.title,
        body: newsItem.body,
        metadata: {
          language: 'en', // https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes
        },
      },
    ],
  }
);

const supportedLanguages = ['en'];

const taskSpec = {
  taskName: 'Priberam-StorylineSummary-Wrapper',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.Summary',
  // override needed because NewsItems are sent to the same worker
  // but result writer is different for them and StorySummary
  resultExchangeNameOverride: 'SUMMA-NLP.StorySummary',
  routingKeys: supportedLanguages,
  taskRoutingKeyFn: () => 'en',

  tableName: 'storylines',

  fieldSpec: {
    highlightItems: {
      dependencyFields: ['newsItems'],
      dependencyFieldConditions: {
        type: 'fieldConditions', value: { field: 'newsItems', status: 'final' },
      },
    },
  },

  workerSpec: {
    endpointSpec: { endpointType: 'rabbitmqClient' },
    inputSchema: {
      type: 'object',
      required: ['documents'],
      additionalProperties: false,
      properties: {
        documents: {
          description: 'array of documents to be summarized',
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'instances'],
            additionalProperties: false,
            properties: {
              id: {
                description: 'The id of the news item',
              },
              instances: {
                description: 'The actual place where the text is supplied',
                type: 'array',
                items: {
                  type: 'object',
                  required: ['title', 'body', 'metadata'],
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    body: { type: 'string' },
                    metadata: {
                      type: 'object',
                      required: ['language'],
                      additionalProperties: false,
                      properties: {
                        language: {
                          type: 'string',
                          enum: ['en'],
                        },
                        date: { type: 'string' },
                        originalLanguage: { type: 'string' },
                        sourceChannel: { type: 'string' },
                        summary: { type: 'string' },
                        tags: { type: 'array' },
                        tokenizedText: { type: 'array' },
                        topics: { type: 'array' },
                      },
                    },
                  },
                },
              },
              source: {
                description: 'Currently not used',
                type: 'object',
              },
              instanceAlignments: {
                description: 'Currently not used',
                type: 'array',
              },
            },
          },
        },
        socialMediaDocuments: {
          description: 'currently not used',
          type: 'array',
        },
        metadata: {
          description: 'Needed when summarization contains multiple newsItems',
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: {
            topic: { type: 'string' },
            id: {
              description: 'storyline id',
              type: 'string',
            },
          },
        },
      },
    },
    outputSchema: {
      description: 'the rest enpdoint response schema',
      type: 'object',
      required: ['highlights'],
      additionalProperties: false,
      properties: {
        highlights: {
          type: 'array',
          items: {
            type: 'object',
            required: ['highlight', 'sentiment', 'language', 'sourceDocuments'],
            additionalProperties: false,
            properties: {
              highlight: { type: 'string' },
              sentiment: {
                description: 'currently not used',
              },
              language: { type: 'string' },
              sourceDocuments: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'language'],
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    language: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    taskTransformerFn: (taskData) => {
      const request = {
        metadata: { id: taskData.id },
        documents: _.values(taskData.newsItems)
          .filter(newsItem => _.has(newsItem, 'title') && _.has(newsItem, 'body'))
          .map(newsItem => newsItem2SummarizationDocument(newsItem)),
      };
      // console.log('****', JSON.stringify(request));
      return request;
    },
    resultTransformerFn: result => (
      result.highlights.map(highlight => _.pick(highlight, 'highlight', 'sentiment'))
    ),
  },
};


export default taskSpec;
