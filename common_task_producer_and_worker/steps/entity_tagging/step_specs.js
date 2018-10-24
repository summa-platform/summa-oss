/* eslint no-console: [2, { allow: ["log", "warn", "error"] }] */

// NOTE that each spec may be run in its own process
//      therefore no sharing of state possible
import _ from 'underscore'; // eslint-disable-line
import crypto from 'crypto';
import { restCall, updateItemInDB } from '../../app/common/restClient';

function createOrUpdateNamedEntities(rawEntities, callback) {
  const address = 'http://db_rest_endpoint/namedEntities';
  const entities = _.chain(rawEntities)
    .pluck('entity')
    .map(entity => _.pick(entity, 'baseForm', 'type', 'id'))
    .value();

  restCall('POST', address, entities, callback);
}

const newsItem2ETRequest = newsItem => (
  {
    id: newsItem.id,
    instances: [
      {
        body: newsItem.body,
        metadata: {
          language: newsItem.language || 'en', // https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes
          originalLanguage: newsItem.language || 'en',
        },
        title: newsItem.title,
      },
    ],
  }
);

const supportedLanguages = ['en'];

const taskSpec = {
  taskName: 'Priberam-EntityTagging-Wrapper',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.EntityTagging',
  routingKeys: supportedLanguages,
  taskRoutingKeyFn: () => 'en',

  tableName: 'newsItems',
  fieldSpec: {
    engTeaserEntities: {
      dependencyFields: ['engTeaser', 'engTitle'],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'engTeaser', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'engTitle', status: 'final' } },
        ],
      },
    },
    engMainTextEntities: {
      dependencyFields: ['engMainText', 'engTitle'],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'engMainText', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'engTitle', status: 'final' } },
        ],
      },
    },
    engTranscriptEntities: {
      dependencyFields: ['engTranscript', 'engTitle'],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'engTranscript', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'engTitle', status: 'final' } },
        ],
      },
    },
  },

  workerSpec: {
    endpointSpec: { endpointType: 'rabbitmqClient' },
    inputSchema: {
      type: 'object',
      required: ['id', 'instances'],
      additionalProperties: false,
      properties: {
        id: {
          description: 'The id of the news item',
        },
        instances: {
          description: 'The actual place where the text is supplied',
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'body', 'metadata'],
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              body: { type: 'string' },
              metadata: {
                type: 'object',
                required: ['language', 'originalLanguage'],
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
          description: 'Currently not used',
          type: 'object',
        },
        instanceAlignments: {
          description: 'Currently not used',
          type: 'array',
        },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['entities'],
      additionalProperties: false,
      properties: {
        entities: {
          description: 'The entities found in the query',
          type: 'array',
          items: {
            type: 'object',
            required: ['entity', 'mentions'],
            additionalProperties: false,
            properties: {
              entity: {
                type: 'object',
                required: ['baseForm', 'type', 'id'],
                additionalProperties: false,
                properties: {
                  baseForm: { type: 'string' },
                  type: { type: 'string' },
                  id: { },
                  currlangForm: { type: 'string' },
                },
              },
              mentions: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['text', 'startPosition', 'endPosition'],
                  properties: {
                    text: { type: 'string' },
                    startPosition: { type: 'integer' },
                    endPosition: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    resultTransformerFn: result => ({
      // go through results and replace anonymous entities with something meaningful
      entities: _.chain(result.entities)
        .map((entity) => {
          // generate unique id for entities that have not been globaly identified - have id NIL000X
          if (entity.entity.id.match(/^NIL\d+$/)) {
            // get base form from mentions, because also NIL000X
            const baseForm = entity.mentions[0].text;
            entity.entity.baseForm = baseForm;

            // generate globaly unique id from base form
            const hash = crypto.createHash('sha256');
            hash.update(entity.entity.baseForm);
            entity.entity.id = hash.digest('hex');
          }
          return entity;
        })
        // now multiple entities can have the same base form
        // reduce to ensure that each base form used only once
        .reduce((acc, entity) => {
          const id = entity.entity.id;
          if (acc[id]) {
            acc[id].mentions = acc[id].mentions.concat(entity.mentions);
          } else {
            acc[id] = entity;
          }
          return acc;
        }, {})
        .values()
        .value(),
    }),
    taskTransformerFn: (taskData) => {
      const newsItem = {
        id: taskData.id,
        body: taskData.engTeaser || taskData.engMainText || taskData.engTranscript,
        title: taskData.engTitle,
      };

      const request = newsItem2ETRequest(newsItem);

      return request;
    },
    dbUpdateFn: ({ itemId, dependencyFieldsHash, resultFieldName,
                   fieldValue, taskSpecificMetadata }, callback) => {
      const { entities } = fieldValue;

      createOrUpdateNamedEntities(entities,
        (entitiesUpsertError) => {
          if (entitiesUpsertError) {
            callback(entitiesUpsertError);
          } else {
            updateItemInDB(taskSpec, itemId, dependencyFieldsHash, resultFieldName,
                           fieldValue, callback);
          }
        },
      );
    },
  },
};


export default taskSpec;
