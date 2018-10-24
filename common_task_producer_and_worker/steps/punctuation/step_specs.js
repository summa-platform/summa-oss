/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import _ from 'underscore';


const supportedLanguages = ['en', 'ar', 'de', 'es', 'lv', 'ru'];

const transcriptSchema = {
  type: 'object',
  required: ['segments'],
  additionalProperties: false,
  properties: {
    segments: {
      type: 'array',
      description: 'arrayes of word confidences and timestamps',
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['word', 'confidence', 'time', 'duration'],
          additionalProperties: false,
          properties: {
            word: { type: 'string' },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            time: {
              type: 'number',
              minimum: 0,
            },
            duration: {
              type: 'number',
              minimum: 0,
            },
          },
        },
      },
    },
  },
};


const taskSpec = {
  taskName: 'SUMMA-Punctuation-Wrapper',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.Punctuation',
  routingKeys: supportedLanguages,
  taskRoutingKeyFn: item => item.contentDetectedLangCode,

  tableName: 'newsItems',

  fieldSpec: {
    contentTranscribedPunctuatedMainText: {
      dependencyFields: ['contentTranscribedMainText', 'contentDetectedLangCode'],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'contentTranscribedMainText', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'contentDetectedLangCode', status: 'final' } },
        ],
      },
    },
  },

  workerSpec: {
    endpointSpec: { endpointType: 'rabbitmqClient' },
    inputSchema: transcriptSchema,
    outputSchema: transcriptSchema,

    taskTransformerFn: taskData => ({
      segments: taskData.contentTranscribedMainText.segments,
    }),
    resultTransformerFn: timestampedTokensList => (
      timestampedTokensList.segments
        .map(segment => segment.map(token => token.word).join(' '))
        .join()
        .toLowerCase()
        .replace(/(?:^\s*|\s+\.\s+)(.)/g, x => x.toUpperCase())
    ),
  },
};


export default taskSpec;
