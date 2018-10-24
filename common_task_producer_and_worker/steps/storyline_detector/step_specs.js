/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */
import { restCall, updateItemInDB } from '../../app/common/restClient';

function createOrUpdateStoryline(storylineId, label, newsItem, mergedStorylineIds, callback) {
  const address = `http://db_rest_endpoint/storylines/${storylineId}`;
  const storylineUpdate = {
    label,
    newsItem,
    source: 'Clusterization',
    mergedStorylineIds,
  };

  restCall('PUT', address, storylineUpdate, callback);
}

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
  taskName: 'LETA-StorylineDetection-Wrapper',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.StorylineDetection',
  routingKeys: supportedLanguages,
  taskRoutingKeyFn: () => 'en',

  tableName: 'newsItems',

  fieldSpec: {
    engStorylineId: {
      dependencyFields: [
        'engTitle',

        'sourceItemTeaser',
        'engTeaser',

        'sourceItemMainText',
        'engMainText',

        'sourceItemVideoURL',
        'engTranscript',

        'timeAdded',
      ],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'engTitle', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'timeAdded', status: 'final' } },
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
        hostname: 'storyline_detection_server',
        port: 8001,
        pathname: '/add',
        query: { },
      },
    },
    inputSchema: {
      description: 'schema for storyline detection endpoint',
      type: 'object',
      required: ['document'],
      additionalProperties: false,
      properties: {
        document: {
          type: 'object',
          required: ['id', 'text'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
          },
        },
      },
    },
    outputSchema: {
      description: 'schema for endpoint result',
      type: 'object',
      required: ['cluster', 'merged'],
      additionalProperties: false,
      properties: {
        cluster: {
          description: 'the id of the cluster into which the given doc has been placed',
          type: 'integer',
        },
        merged: {
          description: 'array with cluster ids that have been merged into the current cluster',
          type: 'array',
          items: {
            type: 'integer',
          },
        },
      },
    },
    taskSpecificMetadataFn: taskData => ({
      engTitle: taskData.engTitle,
      engBody: `${taskData.engTitle || ''} ${taskData.engTeaser || ''} ${taskData.engMainText || ''} ${taskData.engTranscript || ''}`,
      timeAdded: taskData.timeAdded,
    }),
    taskTransformerFn: (taskData) => {
      const requestJSON = {
        document: {
          id: taskData.id,
          text: `${taskData.engTitle || ''} ${taskData.engTeaser || ''} ${taskData.engMainText || ''} ${taskData.engTranscript || ''}`,
        },
      };

      return requestJSON;
    },
    dbUpdateFn: ({ fieldValue, itemId, dependencyFieldsHash,
                   resultFieldName, taskSpecificMetadata },
                 callback) => {
      // console.log('!!!!!!', itemId, taskSpecificMetadata);
      const { cluster, merged } = fieldValue;
      const storylineId = cluster.toString();
      const mergedStorylineIds = merged.map(id => id.toString());

      const label = taskSpecificMetadata.engTitle;
      const newsItem = {
        id: itemId,
        title: taskSpecificMetadata.engTitle,
        body: taskSpecificMetadata.engBody,
        timeAdded: taskSpecificMetadata.timeAdded,
      };

      createOrUpdateStoryline(storylineId, label, newsItem, mergedStorylineIds,
        (storylineErr) => {
          if (storylineErr) {
            callback(storylineErr);
          } else {
            updateItemInDB(taskSpec, itemId, dependencyFieldsHash, resultFieldName,
                           storylineId, callback);
          }
        },
      );
    },
  },
};


export default taskSpec;
