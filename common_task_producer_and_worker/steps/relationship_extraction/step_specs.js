/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import _ from 'underscore';
import { restCall } from '../../app/common/restClient';

function fieldConditions(srcTextField, nelFieldName, amrFieldName) {
  return {
    dependencyFields: [srcTextField, nelFieldName, amrFieldName],
    dependencyFieldConditions: {
      type: 'all',
      value: [
        { type: 'fieldConditions', value: { field: srcTextField, status: 'final' } },
        { type: 'fieldConditions', value: { field: nelFieldName, status: 'final' } },
        { type: 'fieldConditions', value: { field: amrFieldName, status: 'final' } },
      ],
    },
  };
}

function relationsPerEntity(relations) {
  const perEntityRelations = {};

  _.each(relations, (originalRelation) => {
    const ids = _.chain(originalRelation.entities).values().map(entity => entity.id).value();

    if (!_.isEmpty(ids)) {
      const relation = {
        source: originalRelation.source,
        entities: originalRelation.entities,
        name: originalRelation.name,
        roles: originalRelation.roles,
      };

      _.each(ids, (id) => {
        if (id in perEntityRelations) {
          perEntityRelations[id].push(relation);
        } else {
          perEntityRelations[id] = [relation];
        }
      });
    }
  });

  return perEntityRelations;
}

const taskSpec = {
  taskName: 'SUMMA-RELATIONS',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.RelationshipExtraction',
  routingKeys: [],

  tableName: 'newsItems',
  fieldSpec: {
    engTeaserRelationships: fieldConditions('engTeaser', 'engTeaserEntities', 'engTeaserAMR'),
    engMainTextRelationships: fieldConditions('engMainText', 'engMainTextEntities', 'engMainTextAMR'),
    // engTranscriptRelationships: fieldConditions('engTranscript', 'engTranscriptEntities',
    //                                             'engTranscriptAMR'),
  },

  workerSpec: {
    endpointSpec: { endpointType: 'rabbitmqClient' },
    inputSchema: {
      type: 'object',
      required: ['text', 'nel', 'amr'],
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        nel: { },
        amr: { },
        id: { type: 'string' }, // temporary for testing
      },
    },
    outputSchema: { },
    resultTransformerFn: (result) => {
      // update entities
      // console.log('!!! get relations');
      _.each(relationsPerEntity(result), (relations, namedEntityId) => {
        const address = `http://db_rest_endpoint/namedEntities/${namedEntityId}`;
        // console.log('!!! update entity', namedEntity);
        restCall('PATCH', address, relations, (err, res) => console.log('save rel for', namedEntityId, err, res));
      });
      // console.log('!!! return relations');
      return result;
    },
    taskTransformerFn: taskData => ({
      text: (taskData.engTeaser || taskData.engMainText ||
             // taskData.engTranscript ||
             'error'),
      nel: (taskData.engTeaserEntities || taskData.engMainTextEntities ||
            // taskData.engTranscriptEntities ||
            'error'),
      amr: (taskData.engTeaserAMR || taskData.engMainTextAMR ||
            // taskData.engTranscriptAMR ||
            'error'),
      id: taskData.id, // temporary for testing
    }),
  },
};


export default taskSpec;
