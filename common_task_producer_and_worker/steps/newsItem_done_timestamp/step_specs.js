/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */
import _ from 'underscore';

// FIXME: no need to send all the data over just for timestamp
//        need to add option to send only field hashes

function missingOrAllSubsequent(srcFieldName, targetFields) {
  return {
    type: 'any',
    value: [
      { type: 'fieldNotPresent', value: { field: srcFieldName } },
      {
        type: 'all',
        value: _.map(targetFields, fieldName => ({
          type: 'fieldConditions', value: { field: fieldName, status: 'final' },
        })),
      },
    ],
  };
}

function amrAndRelConditions(srcFieldName, targetFields) {
  return {
    type: 'any',
    value: [
      { type: 'fieldNotEqual', value: { field: 'contentDetectedLangCode', fieldValue: 'en' } },
      missingOrAllSubsequent(srcFieldName, targetFields),
    ],
  };
}

const taskSpec = {
  taskName: 'SUMMA-NewsItemDoneTimestamp',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-INTERNAL.NewsItemDoneTimestamp',

  tableName: 'newsItems',

  fieldSpec: {
    doneTimestamp: {
      dependencyFields: [
        'contentDetectedLangCode',

        'sourceItemTitle',
        'engTitle',

        'sourceItemMainText',
        'engMainText',
        'engMainTextEntities',
        // 'engMainTextAMR',           // only for english
        // 'engMainTextRelationships', // only for english

        'sourceItemTeaser',
        'engTeaser',
        'engTeaserEntities',
        // 'engTeaserAMR',             // only for english
        // 'engTeaserRelationships',   // only for english

        'sourceItemVideoURL',
        'contentTranscribedMainText',
        'contentTranscribedPunctuatedMainText',
        'engTranscript',
        'engTranscriptEntities',
        // 'engTranscriptAMR',           // currently these are not calculated
        // 'engTranscriptRelationships', // currently these are not calculated

        'engDetectedTopics',
        'highlightItems',
      ],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          ..._.map([
            ['sourceItemTitle', ['engTitle']],
            ['sourceItemTeaser', ['engTeaser', 'engTeaserEntities']],
            ['sourceItemMainText', ['engMainText', 'engMainTextEntities']],
            ['sourceItemVideoURL', ['contentTranscribedMainText', 'contentTranscribedPunctuatedMainText',
                                    'engTranscript', 'engTranscriptEntities']],
          ], deps => missingOrAllSubsequent(...deps)),

          { type: 'fieldConditions', value: { field: 'engDetectedTopics', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'highlightItems', status: 'final' } },

          // AMR and Relationships are only for English source language
          // amrAndRelConditions('sourceItemTeaser', ['engTeaserAMR', 'engTeaserRelationships']),
          // amrAndRelConditions('sourceItemMainText', ['engMainTextAMR', 'engMainTextRelationships']),
        ],
      },
    },
  },

  workerSpec: {
    endpointSpec: {
      endpointType: 'localFnEndpoint',
      fn: (taskData, callback) => {
        // actually nothing to do here, just return current timestamp
        const error = null;
        const timestamp = Math.floor(Date.now() / 1000);
        callback(error, timestamp);
      },
    },
    inputSchema: {
      description: 'schema for input',
    },
    outputSchema: {
      description: 'schema for endpoint result',
      type: 'number',
    },
  },
};


export default taskSpec;
