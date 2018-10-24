/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import { expect } from 'chai';
import _ from 'underscore';
import { createTask, getTaskId } from '../common/task';
import Rabbit from './rabbit-exchange';
import { getTaskDebugFn } from '../common/debuggers';
import { reportTaskProgress } from '../common/restClient';

let debug;

// fieldSpec: {
//   engTeaser: {
//     dependencyFields: ['sourceItemTeaser', 'contentDetectedLangCode'],
//     dependencyFieldConditions: {
//       type: 'all'
//       value: [
//        { type: 'fieldConditions', value: {field: 'sourceItemTeaser', status: 'final'}},
//        { type: 'fieldConditions',
//          value: {field: 'contentDetectedLangCode',
//                  status: 'final',
//                  acceptableValues: ['ar', 'de', 'ru']}}
//       ],
//     },
//   },
//  },
//
// ## condition types: ##
// {type: 'all', value: []}
// {type: 'any', value: []}
// {type: 'fieldConditions', value: {field: 'abc', status: 'final', acceptableValues: ['val1']}}


function dependencyFieldConditionToRethinkExpr(r, entity, { type, value }) {
  if (type === 'all') {
    return r.and(
      ..._.map(value, condition => dependencyFieldConditionToRethinkExpr(r, entity, condition)));
  } else if (type === 'any') {
    return r.or(
      ..._.map(value, condition => dependencyFieldConditionToRethinkExpr(r, entity, condition)));
  } else if (type === 'fieldConditions') {
    const { field, status, acceptableValues } = value;
    console.assert(field, '[ERR] field is mandatory for conditions with type fieldCondition');
    const fieldConditions = [];
    if (status) {
      const fieldStatusCondition = entity('summaPlatformProcessingMetadata')
        .default({})(field)
        .default({})('status')
        .default(null)
        .eq(status);
      fieldConditions.push(fieldStatusCondition);
    }
    if (acceptableValues) {
      const acceptableValueCondition = r.expr(acceptableValues)
        .contains(entity(field).default(null));
      fieldConditions.push(acceptableValueCondition);
    }
    return r.and(...fieldConditions);
  } else if (type === 'fieldNotPresent') {
    const { field } = value;
    console.assert(field, '[ERR] field is mandatory for conditions with type fieldNotPresent');
    const condition = entity('summaPlatformProcessingMetadata')
      .default({})
      .hasFields(field).not();
    return condition;
  } else if (type === 'fieldNotEqual') {
    const { field, fieldValue } = value;
    console.assert(field, '[ERR] field is mandatory for conditions with type fieldNotEqual');
    console.assert(fieldValue, '[ERR] field is mandatory for conditions with type fieldNotEqual');
    const condition = entity(field).default(null).ne(fieldValue);
    return condition;
  }
  throw Error('Unknows condition type');
}

function currentDependencyHashMatchesCalculatedCache(r, row, resultFieldName,
                                                     sortedDepenedncyFieldNames) {
  const metaData = row('summaPlatformProcessingMetadata').default({});

  const currentDependencyHash = metaData(resultFieldName)
        .default({})('dependencyFieldsHash').default(null);

  const calculatedDependencyHash = r.uuid(r.expr(sortedDepenedncyFieldNames)
    .map(field => metaData.default({})(field).default({})('valueHash').default(null))
    .toJsonString(),
  );

  return currentDependencyHash.eq(calculatedDependencyHash);
}


// 0. get all indexes
// 1. check that there is index for this step
// 2. check that the index name corresponds to the hash of current dependency fields
//    if is index but with wrong hash for current dependencies, then delete it
// 3. create index if missing
// 4 wait for index to become available
async function ensureIndex(r, taskName, tableName, resultFieldName, fieldDependenciesSpec) {
  debug(`[INF] ensure index for task ${taskName} in table ${tableName} field ${resultFieldName}`);
  const table = r.table(tableName);
  // index nameing schema: resultFieldName__stepIndex__fieldSpecHash
  const currentFiledSpecHash = await r.uuid(r.expr(fieldDependenciesSpec).toJsonString());
  const indexNames = await table.indexList();

  const indexPrefix = `stepIndex__${taskName}__${resultFieldName}__`;

  // check that there is current index for this field
  const fieldStepIndexes = _.filter(indexNames,
                              indexName => indexName.startsWith(indexPrefix));

  const requiredFieldStepIndexName = `${indexPrefix}${currentFiledSpecHash}`;
  debug(`[INF] ${resultFieldName} needed index ${requiredFieldStepIndexName}`);

  // clean outdated indexes, usually because dependency spec changed
  const outdatedIndexes = _.without(fieldStepIndexes, requiredFieldStepIndexName);
  for (const indexName of outdatedIndexes) {
    debug(`[INF] deleting outdated index ${indexName}`);
    await table.indexDrop(indexName);
  }

  // create index if missing
  if (!_.contains(fieldStepIndexes, requiredFieldStepIndexName)) {
    const { dependencyFields, dependencyFieldConditions } = fieldDependenciesSpec;
    const sortedDepenedncyFieldNames = _.sortBy(dependencyFields, _.identity);

    debug(`[INF] creating index ${requiredFieldStepIndexName}`);
    const indexCreateResult = await table.indexCreate(requiredFieldStepIndexName, row => [
      dependencyFieldConditionToRethinkExpr(r, row, dependencyFieldConditions),
      currentDependencyHashMatchesCalculatedCache(r, row, resultFieldName,
                                                  sortedDepenedncyFieldNames).not(),
    ]);
    debug(`[INF] index create result for ${requiredFieldStepIndexName}`, indexCreateResult);
  } else {
    debug(`[INF] index present ${requiredFieldStepIndexName}`);
    // console.log('index present', requiredFieldStepIndexName);
  }

  // wait for index to become ready
  debug(`[INF] waiting index ${requiredFieldStepIndexName}`);
  await table.indexWait(requiredFieldStepIndexName);

  debug(`[INF] index ready ${requiredFieldStepIndexName}`);
  // return index name for use further
  return requiredFieldStepIndexName;
}

//
// Pipe RethinkDB liveQuery results to RabbitMQ exchange
//
function start(r, taskSpec) {
  const taskName = taskSpec.taskName;
  // setup debuggers
  debug = getTaskDebugFn(taskSpec.scriptPath);
  const messageExchangeDebug = getTaskDebugFn(taskSpec.scriptPath, 'message_exchange');

  expect(taskSpec, 'taskSpec').to.have.property('exchangeName').with.a('string');
  expect(taskSpec, 'taskSpec').to.have.property('fieldSpec').with.an('object');

  const workerExchangeName = taskSpec.workerExchangeNameOverride || taskSpec.exchangeName;
  const resultExchangeName = taskSpec.resultExchangeNameOverride || taskSpec.exchangeName;
  const address = process.env.MESSAGE_QUEUE_HOST;
  const routingKeys = taskSpec.routingKeys;
  const rabbitExchange = new Rabbit(address, workerExchangeName, resultExchangeName,
                                    routingKeys, messageExchangeDebug);

  let changeCursor;

  const watchDbForField = async (tableName, resultFieldName, fieldDependenciesSpec) => {
    const { dependencyFields, dependencyFieldConditions } = fieldDependenciesSpec;
    const sortedDepenedncyFieldNames = _.sortBy(dependencyFields, _.identity);


    const indexName = await ensureIndex(r, taskName, tableName, resultFieldName,
                                        fieldDependenciesSpec);

    r.table(tableName)
      .getAll([true, true], { index: indexName })
      .pluck(
        'id',
        // watch resultFieldName status changes, in case errors get reset
        { summaPlatformProcessingMetadata: [resultFieldName, ...dependencyFields] },
        ...dependencyFields,
      )
      .changes({ includeInitial: true, squash: true })
      .hasFields('new_val')
      // TODO: filter out changes that involve only setting of new resultField value
      //       otherwise risk of getting into infinite loop;
      //       theoretically should not occure if updates done through API
      .map(change => change('new_val'))
      // TODO: create index at load time
      .filter(row => (
        dependencyFieldConditions
        ? (dependencyFieldConditionToRethinkExpr(r, row, dependencyFieldConditions))
        : true
      ))
      .merge((row) => {
        // NOTE – hash calculation needs to be the same as in
        //        /common_task_producer_and_worker/app/task_producer/task_producer.js
        const calculatedDependencyHash = r.uuid(
                                           r.expr(sortedDepenedncyFieldNames)
                                             .map(field => row('summaPlatformProcessingMetadata')
                                                            .default({})(field)
                                                            .default({})('valueHash')
                                                            .default(null),
                                              )
                                              .toJsonString(),
                                         );

        const resultFieldMetadata = row('summaPlatformProcessingMetadata')
                                      .default({})(resultFieldName)
                                      .default({ status: 'new-noMetadata' });
        const fieldStatus = resultFieldMetadata('status');
        const currentDepenedcyHash = resultFieldMetadata('dependencyFieldsHash').default(null);

        const isFieldReady = fieldStatus.eq('final');
        const isFieldError = fieldStatus.eq('error');

        const isFieldManuallySet = r.and(
                                     isFieldReady,
                                     currentDepenedcyHash.eq(null),
                                   );

        const isFieldNeverProcessed = r.and(
                                      row.hasFields(resultFieldName).not(),
                                      isFieldError.not(),
                                    );

        const isFieldCalculatedButHashesDontMatch = r.and(
                                           isFieldManuallySet.not(),
                                           isFieldReady,
                                           resultFieldMetadata.hasFields('dependencyFieldsHash'),
                                           calculatedDependencyHash.eq(currentDepenedcyHash).not(),
                                         );

        return {
          calculatedDependencyHash,
          needsRecalc: r.or(
            isFieldNeverProcessed,
            isFieldCalculatedButHashesDontMatch,
          ),
          // reasonForRecalc: {
          //   calculatedDependencyHash,
          //   fieldStatus,
          //   isFieldReady,
          //   isFieldManuallySet,
          //   isFieldNeverProcessed,
          //   isFieldCalculatedButHashesDontMatch,
          //   needsRecalc: r.or(
          //     isFieldNeverProcessed,
          //     isFieldCalculatedButHashesDontMatch,
          //   ),
          // },
        };
      })
      // target field either missing
      // or some depenedencies changed (detected through hash)
      .filter({ needsRecalc: true })
      .pluck([
        'id',
        'calculatedDependencyHash',
        'reasonForRecalc',
        ...dependencyFields,
      ])
      .run({ cursor: true }, (queryError, cursor) => {
        if (!queryError) {
          changeCursor = cursor;
          cursor.each((err, change) => {
            // debug(`[DEB] Change: \n${JSON.stringify(change, null, '  ')}`);
            if (!err) {
              if (!change) {
                // no new_val means that the doc no longer matches the query
                // currently just ignore it, for futere it could be used for validation
              } else {
                const entity = change;
                const task = createTask(taskSpec, resultFieldName, entity);

                debug(`[INF] Push ${getTaskId(task)} to MessageExchange`);
                // debug(`${JSON.stringify(task, null, '  ')}`);

                rabbitExchange.push(task);
                // reportTaskProgress(task.payload);
                // FIXME - should report back that the task has been pushed, for progress monitoring
              }
            } else {
              debug('[ERROR] Change watcher error', err);
              console.error(`[ERROR] Change watcher error for ${resultFieldName}; will exit to restart`, err);
              process.exit(1);
            }
          });
        } else {
          console.log('ERROR:', queryError);
          debug('[ERROR] Query error', queryError);
          console.error(`[ERROR] Query error for ${resultFieldName}; will exit to restart`, queryError);
          process.exit(1);
        }
      });
  };

  const watchDb = () => {
    const tableName = taskSpec.tableName;
    _.chain(taskSpec.fieldSpec)
      .keys()
      .each((resultFieldName) => {
        const fieldDependenciesSpec = taskSpec.fieldSpec[resultFieldName];
        debug(`[INF] Watching ${tableName}.${resultFieldName}`);
        watchDbForField(tableName, resultFieldName, fieldDependenciesSpec);
      });
  };

  r.getPoolMaster().on('log', () => {});
  r.getPoolMaster().on('healthy', (healthy) => {
    if (healthy === true) {
      debug('[INF] Databese reconnected');
      watchDb();
    } else {
      debug('[WARN] Databese disconnected');
      if (changeCursor) changeCursor.close();
      changeCursor = null;
    }
  });

  // start initial connection, because healthy event is not fired initally
  debug('[INF] Start watching Databese for changes');
  watchDb();
}


export default { start };
