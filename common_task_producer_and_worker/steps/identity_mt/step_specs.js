/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */

const supportedLanguages = ['en'];

const taskSpec = {
  taskName: 'SUMMA-IdentityMT',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.IdentityMT',
  routingKeys: supportedLanguages,
  taskRoutingKeyFn: item => item.contentDetectedLangCode,

  tableName: 'newsItems',

  fieldSpec: {
    engTeaser: {
      dependencyFields: ['sourceItemTeaser', 'contentDetectedLangCode'],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'sourceItemTeaser', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'contentDetectedLangCode', status: 'final', acceptableValues: supportedLanguages } },
        ],
      },
    },
    engTitle: {
      dependencyFields: ['sourceItemTitle', 'contentDetectedLangCode'],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'sourceItemTitle', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'contentDetectedLangCode', status: 'final', acceptableValues: supportedLanguages } },
        ],
      },
    },
    engMainText: {
      dependencyFields: ['sourceItemMainText', 'contentDetectedLangCode'],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'sourceItemMainText', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'contentDetectedLangCode', status: 'final', acceptableValues: supportedLanguages } },
        ],
      },
    },
    engTranscript: {
      dependencyFields: ['contentTranscribedPunctuatedMainText', 'contentDetectedLangCode'],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'contentTranscribedPunctuatedMainText', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'contentDetectedLangCode', status: 'final', acceptableValues: supportedLanguages } },
        ],
      },
    },
  },

  workerSpec: {
    endpointSpec: {
      endpointType: 'localFnEndpoint',
      fn: (content, callback) => {
        console.log('[INF] identity MT');
        const err = null;
        callback(err, content);
      },
    },
    inputSchema: { type: 'string' },
    outputSchema: { type: 'string' },
    resultTransformerFn: result => result,
    taskTransformerFn: (taskData) => {
      const content = (taskData.sourceItemTeaser || taskData.sourceItemTitle ||
                       taskData.sourceItemMainText ||
                       taskData.contentTranscribedPunctuatedMainText ||
                       'error');
      return content;
    },
  },

  testFn() {
    console.log('[INF] running Identity MT testFn');
  },
};


export default taskSpec;
