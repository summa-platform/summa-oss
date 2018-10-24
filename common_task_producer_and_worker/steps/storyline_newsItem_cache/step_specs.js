/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */
import _ from 'underscore';
import { restCall } from '../../app/common/restClient';

function updateStorylineNewsItemFieldCache(storylineId, newsItem, callback) {
  const address = `http://db_rest_endpoint/storylines/${storylineId}/newsItems/${newsItem.id}`;

  restCall('PATCH', address, newsItem, callback);
}

const taskSpec = {
  taskName: 'SUMMA-StorylineCache',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-INTERNAL.StorylineCache',

  tableName: 'newsItems',

  fieldSpec: {
    cacheFieldsInStorylineDone: {
      dependencyFields: [
        'engStorylineId',

        'engTeaserEntities',
        'engMainTextEntities',
        'engTranscriptEntities',

        'feedId',
        'contentDetectedLangCode',
        'sourceItemType',
      ],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'engStorylineId', status: 'final' } },

          {
            type: 'any',
            value: [
              { type: 'fieldConditions', value: { field: 'engTeaserEntities', status: 'final' } },
              { type: 'fieldConditions', value: { field: 'engMainTextEntities', status: 'final' } },
              { type: 'fieldConditions', value: { field: 'engTranscriptEntities', status: 'final' } },
              { type: 'fieldConditions', value: { field: 'feedId', status: 'final' } },
              { type: 'fieldConditions', value: { field: 'contentDetectedLangCode', status: 'final' } },
              { type: 'fieldConditions', value: { field: 'sourceItemType', status: 'final' } },
            ],
          },
        ],
      },
    },
  },

  workerSpec: {
    endpointSpec: {
      endpointType: 'localFnEndpoint',
      fn: (taskData, callback) => {
        const engStorylineId = taskData.engStorylineId;

        const entityFields = ['engTeaserEntities', 'engMainTextEntities', 'engTranscriptEntities'];
        const entities = _.reduce(
          entityFields,
          (acc, field) => (
            acc.concat(
              _.map(
                (taskData[field] || { entities: [] }).entities,
                entity => entity.entity.baseForm),
            )
          ),
          []);

        const newsItem = {
          id: taskData.id,

          entities,

          feedId: taskData.feedId,
          contentDetectedLangCode: taskData.contentDetectedLangCode,
          sourceItemType: taskData.sourceItemType,
        };

        updateStorylineNewsItemFieldCache(
          engStorylineId, newsItem, updateErr => callback(updateErr, true),
        );
      },
    },
    inputSchema: {
      description: 'schema for caching',
      type: 'object',
    },
    outputSchema: {
      description: 'schema for endpoint result',
      type: 'boolean',
    },
  },
};


export default taskSpec;
