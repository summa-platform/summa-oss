/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import r from 'rethinkdb';
import jsonfile from 'jsonfile';

// #### Connection details
// RethinkDB database settings. Defaults can be overridden using environment variables.
const configFile = '/config/config.json';

/**
 * Connect to RethinkDB instance and perform a basic database setup:
 *
 * - create the `RDB_DB` database (defaults to `summa_db`)
 * - create table `segments` in this database
 */

function connectOrRetry(dbConfig, doCallback) {
  r.connect({ host: dbConfig.host, port: dbConfig.port }, (err, connection) => {
    if (err) {
      console.log('[INF] connection failed; restarting');
      setTimeout(() => connectOrRetry(dbConfig, doCallback), 1000);
    } else {
      doCallback(connection);
    }
  });
}

async function createIndexQuery(connection,
                                dbName, tableName,
                                indexName, indexFn,
                                isMulti = false) {
  try {
    const res = await r.db(dbName)
      .table(tableName).indexList()
      .contains(indexName)
      .do(indexExists => (
        r.branch(
          indexExists,
          { status: 'index already exists' },
          r.db(dbName)
            .table(tableName)
            .indexCreate(indexName, indexFn, { multi: isMulti }),
        )
      ))
      .run(connection);
    console.log(`[INF] created index for ${tableName} -> ${indexName}`, res);
  } catch (err) {
    console.log(`[ERR] failed to create index for ${tableName} -> ${indexName}`, err);
  }
}

const setup = async () => {
  console.log('[INFO ] setup started');
  const config = await new Promise((resolve, reject) => {
    jsonfile.readFile(configFile, (err, res) => (err ? reject(err) : resolve(res)));
  });
  console.log('[INFO ] starting RethinkDB setup');

  const dbConfig = config.db;
  const dbName = dbConfig.dbName;

  const createTablesCallback = async (connection) => {
    console.log('[INFO ] established connection to RethinkDB');

    // create db
    try {
      const result = await r.dbCreate(dbConfig.dbName).run(connection);
      console.log(`[INFO ] RethinkDB database '${dbConfig.dbName}' created`, result);
    } catch (err) {
      console.log(`[INFO ] RethinkDB database '${dbConfig.dbName}' already exists`);
    }

    // create tables
    console.log('[INFO ] create tables');
    for (const tableName of Object.keys(dbConfig.tables)){
      try {
        const res = await r.db(dbConfig.dbName)
          .tableList()
          .contains(tableName)
          .do(tableExists => (
            r.branch(
              tableExists,
              { status: 'table already exists' },
              r.db(dbConfig.dbName)
                .tableCreate(tableName, { primaryKey: dbConfig.tables[tableName] }),
            )
          ))
          .run(connection);
        console.log(`create table '${tableName}'`, res);
      } catch (err) {
        console.log(`create table '${tableName}' error`, err);
      }
    }
    console.log('[INF] all needed tables exist');

    // create admin user_user
    try {
      const adminUser = {
        email: 'admin@summa',
        id: 'defaultAdmin',
        isSuspended: false,
        name: 'admin',
        role: 'admin',
        // saltedPasswordHash for password 'admin'
        saltedPasswordHash: '$argon2i$v=19$m=4096,t=3,p=1$kIoPzryeg9j8+EHo7UBtIQ$if6i8mj6RbO6egpTxcj5QTpiZp5AYPEWVcldP3ae5fk',
      };
      await r.db(dbConfig.dbName)
        .table('users')
        .insert(adminUser, { conflict: 'error' })
        .run(connection);
      console.log('[INF] admin@summa:admin user created');
    } catch (err) {
      console.log('[INF] admin@summa:admin user exists', err);
    }

    // create extra indexes to speed things up
    // newsItems feedId-TimeAdded
    createIndexQuery(connection, dbName, 'newsItems',
                     'feedId-TimeAdded', row => [row('feedId'), row('timeAdded')]);
    // newsItems storylineId-timeAdded
    createIndexQuery(connection, dbName, 'newsItems',
                     'storylineId-timeAdded', row => [row('engStorylineId'), row('timeAdded')]);
    // newsItems entity-timeAdded
    createIndexQuery(connection, dbName, 'newsItems',
                     'entity-timeAdded',
                     row => row('entitiesCache').default([]).map(entity => [entity, row('timeAdded')]),
                     true);
    // newsItems namedEntities
    createIndexQuery(connection, dbName, 'newsItems',
                     'namedEntities',
                     row => row('entitiesCache').default([]),
                     true);
    // newsItems sourceItemIdAtOrigin
    createIndexQuery(connection, dbName, 'newsItems',
                     'sourceItemIdAtOrigin',
                     row => row('sourceItemIdAtOrigin'),
                     true);
    // newsItems timeAdded
    createIndexQuery(connection, dbName, 'newsItems',
                     'timeAdded',
                     row => row('timeAdded'),
                     true);
    // newsItems doneTimestamp
    createIndexQuery(connection, dbName, 'newsItems',
                     'doneTimestamp',
                     row => row('doneTimestamp'),
                     true);
    // bookmarks userId
    createIndexQuery(connection, dbName, 'bookmarks',
                     'userId',
                     row => row('userId'),
                     true);
    // feeds url
    createIndexQuery(connection, dbName, 'feeds',
                     'url',
                     row => row('url'),
                     true);

    // namedEntities baseForm
    createIndexQuery(connection, dbName, 'namedEntities',
                     'baseForm',
                     row => row('baseForm'));

    //
    // progressReports tableName, fieldName, itemId
    createIndexQuery(connection, dbName, 'progressReports',
                     'itemId-resultFieldName',
                     row => [row('itemId'), row('resultFieldName')],
                     true);
  };

  connectOrRetry(dbConfig, createTablesCallback);
};

setup();
