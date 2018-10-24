/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */


function missingOrFinal(srcFieldName) {
  return {
    type: 'any',
    value: [
      { type: 'fieldNotPresent', value: { field: srcFieldName } },
      { type: 'fieldConditions', value: { field: srcFieldName, status: 'final' } },
    ],
  };
}

function atleastOneFieldPresent(fieldNameList) {
  return {
    type: 'any',
    value: fieldNameList.map(fieldName => ({
      type: 'fieldConditions',
      value: { field: fieldName, status: 'final' },
    })),
  };
}

const taskSpec = {
  taskName: 'SUMMA-LANG_DETECT',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.LanguageDetection',
  routingKeys: [],

  tableName: 'newsItems',
  fieldSpec: {
    contentDetectedLangCode: {
      dependencyFields: [
        'sourceItemTeaser',
        'sourceItemMainText',
        'sourceItemLangeCodeGuess',
      ],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'sourceItemLangeCodeGuess', status: 'final' } },
          atleastOneFieldPresent(['sourceItemTeaser', 'sourceItemMainText']),
          missingOrFinal('sourceItemTeaser'),
          missingOrFinal('sourceItemMainText'),
        ],
      },
    },
  },

  workerSpec: {
    endpointSpec: { endpointType: 'rabbitmqClient' },
    inputSchema: {
      type: 'object',
      required: ['feedLang', 'text'],
      additionalProperties: false,
      properties: {
        feedLang: { type: 'string' },
        text: { type: 'string' },
        id: { type: 'string' }, // temporary for testing
      },
    },
    outputSchema: { },
    resultTransformerFn: result => result,
    taskTransformerFn: taskData => ({
      feedLang: taskData.sourceItemLangeCodeGuess,
      text: `${taskData.sourceItemTeaser || ' '} ${taskData.sourceItemMainText || ''}`,
      id: taskData.id, // temporary for testing
    }),
  },
};


export default taskSpec;
