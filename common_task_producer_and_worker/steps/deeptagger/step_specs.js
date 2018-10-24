/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */

// import _ from 'underscore';
// NOTE that each spec may be run in its own process
//      therefore no sharing of state possible


// const langCodeToLanguageMap = {
//   en: 'english',
//   de: 'german',
//   ar: 'arabic',
//   pt: 'portuguese',
//   fa: 'persian',
//   ru: 'russian',
//   uk: 'ukrainian',
//   es: 'spanish',
// };

const supportedLanguages = ['en'];

const fieldSourceMissingOrTranslated = (srcFieldName, translatedFieldName) => ({
  type: 'any',
  value: [
    { type: 'fieldNotPresent', value: { field: srcFieldName } },
    {
      type: 'all',
      value: [
        { type: 'fieldConditions', value: { field: srcFieldName, status: 'final' } },
        { type: 'fieldConditions', value: { field: translatedFieldName, status: 'final' } },
      ],
    },
  ],
});

const taskSpec = {
  taskName: 'SUMMA-DeepTagging-Wrapper',
  taskVersion: '0.0.3',

  exchangeName: 'SUMMA-NLP.DeepTagging',
  routingKeys: supportedLanguages,
  taskRoutingKeyFn: () => 'en',

  tableName: 'newsItems',
  fieldSpec: {
    engDetectedTopics: {
      dependencyFields: [
        'sourceItemTitle',
        'engTitle',

        'sourceItemTeaser',
        'engTeaser',

        'sourceItemMainText',
        'engMainText',

        'sourceItemVideoURL',
        'engTranscript',
      ],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          fieldSourceMissingOrTranslated('sourceItemTitle', 'engTitle'),
          fieldSourceMissingOrTranslated('sourceItemTeaser', 'engTeaser'),
          fieldSourceMissingOrTranslated('sourceItemMainText', 'engMainText'),
          fieldSourceMissingOrTranslated('sourceItemVideoURL', 'engTranscript'),
        ],
      },
    },
  },
  workerSpec: {
    endpointSpec: {
      endpointType: 'remoteRestfulEndpoint',
      url: {
        protocol: 'http',
        hostname: 'deeptagger_server',
        port: 6000,
        pathname: 'tag',
        query: {
          input_language: 'english', // will be filled by customizeUrlFn
          label_types: 'rou,cat,kw',
          languages: 'english',
        },
      },
      // customizeUrlFn: (url, taskMetadata) => {
      //   // clone original url
      //   const urlClone = JSON.parse(JSON.stringify(url));
      //   urlClone.query.input_language = langCodeToLanguageMap[taskMetadata.contentDetectedLangCode];
      //   return urlClone;
      // },
    },
    inputSchema: {
      type: 'object',
      required: ['trackingInfo', 'name', 'categoryName', 'text'],
      additionalProperties: false,
      properties: {
        trackingInfo: {
          type: 'object',
          description: 'guess uses as additonal info from DW. summa will ignore it, because not all items have it',
          required: ['customCriteria'],
          additionalProperties: false,
          properties: {
            customCriteria: {
              type: 'object',
              required: ['x5', 'x10'],
              additionalProperties: false,
              properties: {
                x10: { type: 'string' },
                x5: { type: 'string' },
              },
            },
          },
        },
        name: {
          type: 'string',
          description: 'summa will ignore, use just text',
        },
        categoryName: {
          type: 'string',
          description: 'summa will ignore, not all items have that',
        },
        text: {
          type: 'string',
          description: 'the actual value',
        },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['kw_english', 'rou_english', 'cat_english'],
      additionalProperties: false,
      properties: {
        kw_english: {
          description: 'TODO',
          type: 'object',
          required: ['tags'],
          properties: {
            tags: {
              type: 'array',
              items: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: {
                  type: 'string',
                },
              },
            },
          },
          // required: ['text', 'watts', 'labels', 'satts', 'tags'],
          // additionalProperties: false,
        },
        rou_english: {
          description: 'TODO',
          type: 'object',
          required: ['tags'],
          properties: {
            tags: {
              type: 'array',
              items: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: {
                  type: 'string',
                },
              },
            },
          },
          // required: ['text', 'watts', 'labels', 'satts', 'tags'],
          // additionalProperties: false,
        },
        cat_english: {
          description: 'TODO',
          type: 'object',
          required: ['tags'],
          properties: {
            tags: {
              type: 'array',
              items: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: {
                  type: 'string',
                },
              },
            },
          },
          // required: ['text', 'watts', 'labels', 'satts', 'tags'],
          // additionalProperties: false,
        },
      },
    },
    resultTransformerFn: result => (
      // strip out extra information
      // leave only tags
      {
        kw_english: {
          tags: result.kw_english.tags,
        },
        rou_english: {
          tags: result.rou_english.tags,
        },
        cat_english: {
          tags: result.cat_english.tags,
        },
      }
    ),
    taskTransformerFn: (taskData) => {
      const text = `${taskData.engTitle || ''} \n ${taskData.engMainText || ''} \n  ${taskData.engTranscript}`;
      const request = {
        trackingInfo: { customCriteria: { x10: '', x5: '' } },
        name: '',
        categoryName: '',
        text,
      };

      return request;
    },
  },
};


export default taskSpec;
