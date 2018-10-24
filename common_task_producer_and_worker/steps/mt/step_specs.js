/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */


function sentenceToTokens(sentenceString) {
  // split into words
  // map words to tokens
  return {
    tokens: sentenceString.split(' ').map((token, offset) => ({
      features: [],
      token: {
        offset,
        token,
      },
    })),
  };
}

function formatSentencesForMT(sentenceStringArray, documentID) {
  const requestJSON = {
    id: documentID,
    source: {
      type: '',
      url: '',
    },
    instanceAlignments: [],
    instances: [
      {
        title: '',
        metadata: {
          date: '',
          language: 'en',
          originalLanguage: '',
          sourceChannel: '',
          summary: '',
          tags: [],
          tokenizedText: [],
          topics: [],
        },
        body: {
          sentences: sentenceStringArray.map(sentenceToTokens),
        },
      },
    ],
  };

  return requestJSON;
}

function getTextFromBody(body) {
  return body.sentences
    .map(sentence => (
      sentence.tokens.map(token => (
        token.token.token
      ))
      .join(' ')),
    ).join('. ');
}

const supportedLanguages = ['de', 'ar', 'es', 'ru', 'lv'];

const taskSpec = {
  taskName: 'SUMMA-MT-Wrapper',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.MT',
  routingKeys: supportedLanguages,
  taskRoutingKeyFn: item => item.contentDetectedLangCode,

  tableName: 'newsItems',

  fieldSpec: {
    // deTeaser: ['engTeaser'],
    // deTitle: ['engTitle'],
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
    endpointSpec: { endpointType: 'rabbitmqClient' },
    inputSchema: {
      type: 'object',
      required: ['id', 'source', 'instances', 'instanceAlignments'],
      additionalProperties: false,
      properties: {
        id: {
          description: 'The id of the news item',
        },
        instances: {
          description: 'The actual place where the text is supplied',
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: {
            type: 'object',
            required: ['title', 'body', 'metadata'],
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              body: {
                type: 'object',
                required: ['sentences'],
                additionalProperties: false,
                properties: {
                  sentences: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['tokens'],
                      additionalProperties: false,
                      properties: {
                        tokens: {
                          type: 'array',
                          minItems: 1,
                          items: {
                            type: 'object',
                            required: ['features', 'token'],
                            additionalProperties: false,
                            properties: {
                              features: { type: 'array' },
                              token: {
                                type: 'object',
                                required: ['offset', 'token'],
                                additionalProperties: false,
                                properties: {
                                  offset: { type: 'integer' },
                                  sourceDocument: { },
                                  token: { type: 'string' },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
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
          description: 'Currently not used but required by mt server validation',
          type: 'object',
          required: ['type', 'url'],
          additionalProperties: false,
          properties: {
            type: { type: 'string' },
            url: { type: 'string' },
          },
        },
        instanceAlignments: {
          description: 'Currently not used',
          type: 'array',
        },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['id', 'source', 'instances', 'instanceAlignments'],
      additionalProperties: false,
      properties: {
        id: {
          description: 'The id of the news item',
        },
        instances: {
          description: 'The actual place where the text is supplied',
          type: 'array',
          minItems: 2, // the translation is supplied as the second element
          maxItems: 2, // of the instances array
          items: {
            type: 'object',
            required: ['title', 'body', 'metadata'],
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              body: {
                type: 'object',
                required: ['sentences'],
                additionalProperties: false,
                properties: {
                  sentences: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['tokens'],
                      additionalProperties: false,
                      properties: {
                        tokens: {
                          type: 'array',
                          minItems: 1,
                          items: {
                            type: 'object',
                            required: ['features', 'token'],
                            additionalProperties: false,
                            properties: {
                              features: { type: 'array' },
                              token: {
                                type: 'object',
                                required: ['offset', 'token'],
                                additionalProperties: false,
                                properties: {
                                  offset: { type: 'integer' },
                                  sourceDocument: { },
                                  token: { type: 'string' },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              metadata: {
                type: 'object',
                required: ['language'],
                additionalProperties: false,
                properties: {
                  language: {
                    type: 'string',
                    enum: ['en', 'de'],
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
          description: 'Currently not used but required by mt server validation',
          type: 'object',
          required: ['type', 'url'],
          additionalProperties: false,
          properties: {
            type: { type: 'string' },
            url: { type: 'string' },
          },
        },
        instanceAlignments: {
          description: 'Currently not used',
          type: 'array',
        },
      },
    },
    resultTransformerFn: result => getTextFromBody(result.instances[1].body),
    taskTransformerFn: (taskData) => {
      const content = (taskData.sourceItemTeaser || taskData.sourceItemTitle ||
                       taskData.sourceItemMainText ||
                       taskData.contentTranscribedPunctuatedMainText ||
                       'error');
      const sentenceStringArray = content.split('.');

      // re-introduce sentence dots
      for(const i in sentenceStringArray) {
        sentenceStringArray[i] += '.';
      }
      if(sentenceStringArray.length > 0 && sentenceStringArray[sentenceStringArray.length-1] == '.') {
        sentenceStringArray.pop();
      }

      const requestJSON = formatSentencesForMT(sentenceStringArray, taskData.id);

      return requestJSON;
    },
    taskSpecificMetadataFn: taskData => ({
      contentDetectedLangCode: taskData.contentDetectedLangCode,
    }),
  },

  testFn() {
    console.log('[INF] running MT testFn');
  },
};


export default taskSpec;
