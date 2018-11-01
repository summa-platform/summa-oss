/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */
import moment from 'moment';
import _ from 'underscore';
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

const supportedLanguages = ['en'];

const taskSpec = {
  taskName: 'Priberam-StorylineDetection-Wrapper',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.Clustering',
  routingKeys: supportedLanguages,
  taskRoutingKeyFn: () => 'en',

  tableName: 'newsItems',

  fieldSpec: {
    engStorylineId: {
      dependencyFields: [
        'engTitle',
        'sourceItemType',
        'feedURL',

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
        hostname: 'clustering_server',
        port: 5000,
        callType: 'PUT',
        pathname: '/clustering/document',
        query: { async: false },
      },
    },
    inputSchema: {
      description: 'schema for storyline detection endpoint',
      type: 'object',
      required: ['id', 'text'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        text: {
          type: 'object',
          required: ['body'],
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
          },
        },
        timestamp: { type: 'string' },
        timestamp_format: { const: '%Y-%m-%d %H:%M:%S' },
        language: { const: 'en' },
        group_id: { const: 'English' },
        callback_url: { const: '' }, //TODO: remove when possible
        media_item_type: { const: '' },
        source_feed_name: { const: '' },
      },
    },
    outputSchema: {
      description: 'schema for endpoint result',
      type: 'object',
      required: ['cluster_id', 'document_id'],
      additionalProperties: true,
      properties: {
        merged_cluster_ids: {
          description: 'array with cluster ids that have been merged into the current cluster',
          type: 'array',
          items: {
            type: 'integer',
          },
        },
        cluster_id: { type: 'number' },
        document_id: { type: 'string' },
        group_id: { const: 'English' },
        language: { const: 'en' },
        type: { const: 'mono' },
      },
    },
    taskSpecificMetadataFn: taskData => ({
      engTitle: taskData.engTitle,
      engBody: `${taskData.engTitle || ''} ${taskData.engTeaser || ''} ${taskData.engMainText || ''} ${taskData.engTranscript || ''}`,
      timeAdded: taskData.timeAdded,
    }),
    taskTransformerFn: (taskData) => {
      const requestJSON = {
        id: taskData.id,
        text: {
          title: taskData.engTitle,
          body: `${taskData.engTeaser || ''} ${taskData.engMainText || ''} ${taskData.engTranscript || ''}`,
        },
        timestamp: moment(taskData.timeAdded).format('YYYY-MM-DD HH:mm:ss.SSS'),
        timestamp_format: '%Y-%m-%d %H:%M:%S.%f',
        language: 'en',
        group_id: 'English',
        callback_url: '',
        media_item_type: taskData.sourceItemType,
        source_feed_name: taskData.feedURL,

      };

      return requestJSON;
    },
    dbUpdateFn: ({ fieldValue, itemId, dependencyFieldsHash,
                   resultFieldName, taskSpecificMetadata },
                 callback) => {
      // console.log('!!!!!!', itemId, taskSpecificMetadata);
      const monoUpdate = fieldValue;
      const { cluster_id: clusterId } = monoUpdate;
      const { document_id: documentId } = monoUpdate;
      const mergedStorylineIds = monoUpdate.merged_cluster_ids.map(id => id.toString());
      const storylineId = clusterId.toString();

      const label = taskSpecificMetadata.engTitle;
      const newsItem = {
        id: documentId,
        title: taskSpecificMetadata.engTitle,
        body: taskSpecificMetadata.engBody,
        timeAdded: taskSpecificMetadata.timeAdded,
      };
      console.log(`Creating/Updating Story on ${storylineId}; doc: ${documentId}`, newsItem);
      createOrUpdateStoryline(storylineId, label, newsItem, mergedStorylineIds,
        (storylineErr) => {
          if (storylineErr) {
            callback(storylineErr);
          } else {
            updateItemInDB(taskSpec, documentId, dependencyFieldsHash, resultFieldName,
                           storylineId, callback);
          }
        },
      );
    },
  },
};


export default taskSpec;
