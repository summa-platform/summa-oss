/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

const supportedLanguages = ['en']; // , 'ar', 'de', 'lv', 'es', 'ru'];

function fieldConditions(srcFieldName) {
  return {
    dependencyFields: [srcFieldName, 'contentDetectedLangCode'],
    dependencyFieldConditions: {
      type: 'all',
      value: [
        { type: 'fieldConditions', value: { field: srcFieldName, status: 'final' } },
        { type: 'fieldConditions',
          value: {
            field: 'contentDetectedLangCode',
            status: 'final',
            acceptableValues: supportedLanguages,
          },
        },
      ],
    },
  };
}

const taskSpec = {
  taskName: 'SUMMA-AMR',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.AMR',
  routingKeys: [],

  tableName: 'newsItems',
  fieldSpec: {
    engTeaserAMR: fieldConditions('engTeaser'),
    engMainTextAMR: fieldConditions('engMainText'),
    // engTranscriptAMR: fieldConditions('engTranscript'),
  },

  workerSpec: {
    endpointSpec: { endpointType: 'rabbitmqClient' },
    inputSchema: {
      type: 'object',
      required: ['lang', 'text'],
      additionalProperties: false,
      properties: {
        lang: { type: 'string' },
        text: { type: 'string' },
        id: { type: 'string' }, // temporary for testing
      },
    },
    outputSchema: { },
    resultTransformerFn: result => result,
    taskTransformerFn: taskData => ({
      lang: taskData.contentDetectedLangCode,
      text: (taskData.engTeaser || taskData.engMainText ||
             // taskData.engTranscript ||
             'error'),
      id: taskData.id, // temporary for testing
    }),
  },
};


export default taskSpec;
