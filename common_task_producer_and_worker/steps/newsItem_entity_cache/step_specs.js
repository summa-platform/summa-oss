/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */
import _ from 'underscore';

const taskSpec = {
  taskName: 'SUMMA-NewsItemEntitiesCache',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-INTERNAL.NewsItemEntitiesCache',

  tableName: 'newsItems',

  fieldSpec: {
    entitiesCache: {
      dependencyFields: [
        'engTeaserEntities',
        'engMainTextEntities',
        'engTranscriptEntities',
      ],
      dependencyFieldConditions: {
        type: 'any',
        value: [
          { type: 'fieldConditions', value: { field: 'engTeaserEntities', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'engMainTextEntities', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'engTranscriptEntities', status: 'final' } },
        ],
      },
    },
  },

  workerSpec: {
    endpointSpec: {
      endpointType: 'localFnEndpoint',
      fn: (taskData, callback) => {
        const entityFields = ['engTeaserEntities', 'engMainTextEntities', 'engTranscriptEntities'];
        const entities = _.reduce(
          entityFields,
          (acc, field) => {
            _.each(
              (taskData[field] || { entities: [] }).entities,
              entity => acc.add(entity.entity.baseForm),
            );
            return acc;
          },
          new Set());

        const error = null;
        callback(error, Array.from(entities));
      },
    },
    inputSchema: {
      description: 'schema for caching',
    },
    outputSchema: {
      description: 'schema for endpoint result',
      type: 'array',
      items: {
        type: 'string',
      },
    },
  },
};


export default taskSpec;
