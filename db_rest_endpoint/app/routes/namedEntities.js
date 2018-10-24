/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import { Router } from 'express';
import Ajv from 'ajv';
import _ from 'underscore';
import { reportError, formatValidationErrors } from '../common/errorReporting.js';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
  v5: true,
});
// 'subStorylinesIncludingSelf',
const entitiesUpsertSchema = {
  title: 'entities upsert schema',
  description: 'The entities to be upserted',
  type: 'array',
  items: {
    type: 'object',
    required: ['id', 'baseForm', 'type'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      baseForm: { type: 'string' },
      type: { type: 'string' },
      timeAdded: {
        description: 'time when the entity was detected',
        type: 'string',
        format: 'date-time',
      },
    },
  },
};

const relationsSchema = {
  type: 'array',
  items: {
    type: 'object',
  },
};

const validateEntitiesUpsert = ajv.compile(entitiesUpsertSchema);
const validateRelations = ajv.compile(relationsSchema);

export default (r, topLevelPath) => { // eslint-disable-line
  const router = new Router();

  router.get('/', async (request, response, next) => {
    const sinceEpochTime = request.query.sinceEpochTime;
    // rethink db has problems return arrays with more than 100'000 elements
    // therefore get count of elemnets
    // and then make multiple request to get get all items
    const typeBlackList = ['time', 'unk', 'url', 'price', 'email'];
    const entityQuery = r.db('summa_db')
      .table('namedEntities')
      .filter(row => r.expr(typeBlackList).contains(row('type')).not())
      // return only latest
      .filter(isNaN(sinceEpochTime) ? true : r.row('timeAdded').toEpochTime().ge(+sinceEpochTime))
      .merge(namedEntity => ({
        relationshipCount: namedEntity('relationships').default([]).count(),
      }))
      .without('relationships')
      .sample(50000)
      .orderBy(r.desc('relationshipCount'));

    try {
      const itemCount = await entityQuery.count().run();

      const maxItemsPerRequest = 100000;
      const requestCount = Math.floor(itemCount / maxItemsPerRequest) + 1;
      const queries = _.chain(requestCount)
        .range()
        .map(i => entityQuery.slice(i * maxItemsPerRequest, (i + 1) * maxItemsPerRequest))
        .map(query => query.run())
        .value();

      const results = await Promise.all(queries);
      const entities = [].concat(...results);
      const serverEpochTime = await r.now().toEpochTime().round();

      response.status(200) // 200 – ok
        .header('server-epoch-time', serverEpochTime)
        .json({
          serverEpochTime,
          entities,
          count: itemCount,
        });
      next();
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to get namedEntities',
        description: err,
      });
      next();
    }
  });

  router.get('/:id', (request, response, next) => {
    const id = request.params.id;

    r.db('summa_db')
      .table('namedEntities')
      .get(id)
      .do(namedEntity => (
        // Only perform a merge if namedEntity isn't null
        r.branch(
          namedEntity.eq(null),
          null,
          namedEntity.merge({
            mentions: r.db('summa_db')
              .table('newsItems')
              .getAll(namedEntity('baseForm').default(''), { index: 'namedEntities' })
              .limit(500)
              .pluck('id', 'engTitle', 'timeAdded',
                     'contentDetectedLangCode', 'sourceItemOriginFeedName',
                     'sourceItemType')
              .coerceTo('array'),
          }),
        )
      ))
      .run()
      .then((result) => {
        if (result === null) {
          response.status(404) // 404 – not found
            .json(result);
        } else {
          response.status(200) // 200 – ok
            .json(result);
        }
        next();
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get namedEntity ${id}`,
          description: err,
        });
        next();
      });
  });

  router.post('/', (request, response, next) => {
    const requestContent = request.body;

    if (!validateEntitiesUpsert(requestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateEntitiesUpsert.errors),
      });
    } else {
      // need unique, because rethinkDB crashes if inserting multiple items with duplicate keys
      const uniqueEntities = _.chain(requestContent)
        .unique(entity => entity.id)
        .map(entity => ({
          ...entity,
          timeAdded: entity.timeAdded ? new Date(entity.timeAdded) : r.now(),
        }))
        .value();

      r.db('summa_db')
        .table('namedEntities')
        .insert(
          uniqueEntities, {
            durability: 'soft',
            returnChanges: 'always',
            conflict: ((id, oldDoc, newDoc) => (
              r.branch(
                oldDoc('timeAdded').lt(newDoc('timeAdded')),
                oldDoc,
                newDoc,
              )
            )),
          },
        )
        .run()
        .then((result) => {
          response.status(201) // 201 – created
            .json(_.pluck(result.changes, 'new_val'));
          next();
        })
        .error((err) => {
          reportError(response, {
            httpStatusCode: 500,
            message: 'Failed to upsert entities',
            description: err,
          });
          next();
        });
    }
  });

  router.patch('/:id', (request, response, next) => {
    const id = request.params.id;
    const requestContent = request.body;
    // console.log('!!! updating relations for', id);
    if (!validateRelations(requestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateEntitiesUpsert.errors),
      });
      next();
    } else {
      r.db('summa_db')
        .table('namedEntities')
        .get(id)
        .update(namedEntity => ({
          relationships: namedEntity('relationships').default([]).add(requestContent),
        }), { durability: 'soft' })
        .run()
        .then(() => {
          response.status(200); // 200 – ok
          next();
        })
        .error((err) => {
          reportError(response, {
            httpStatusCode: 500,
            message: 'Failed to update relationships',
            description: err,
          });
          next();
        });
    }
  });

  router.get('/resetAllRelationships', (request, response, next) => {
    r.db('summa_db')
      .table('namedEntities')
      .update({ relationships: r.literal() }, { durability: 'soft' })
      .run()
      .then(() => {
        response.status(200); // 200 – ok
        next();
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: 'Failed to reset all relationships',
          description: err,
        });
        next();
      });
  });

  return router;
};
