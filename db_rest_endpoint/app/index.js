/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import Kefir from 'kefir';
import jsonfile from 'jsonfile';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors'; // for cross origin calls
import rDash from 'rethinkdbdash';
import url from 'url';
import nocache from 'nocache';

import newsItemsAPI from './routes/news-items.js';
import storylineAPI from './routes/storylines.js';
import namedEntitiesAPI from './routes/namedEntities.js';
import logMessagesAPI from './routes/log-messages.js';
import usersAPI from './routes/users.js';
import feedsAPI from './routes/feeds.js';
import feedGroupsAPI from './routes/feedGroups.js';
import queriesAPI from './routes/queries.js';
import storiesApi from './routes/stories.js';
import mediaItemsApi from './routes/mediaItems.js';
import feedbackAPI from './routes/feedback.js';
import taskProgressAPI from './routes/taskProgress.js';


console.log('\nStarting The SummaDB REST Endpoint');


//
// Config
//
const configFilePath = '/config/config.json';

Kefir
  .fromNodeCallback(callback => (jsonfile.readFile(configFilePath, callback)))
  .map(config => config.db)
  .onValue((dbConfig) => {
    const r = rDash({
      db: dbConfig.dbName,
      servers: [dbConfig],
    });

    //
    // Express Server
    //
    const app = express();
    // increased size to handle deeptagger results
    // see http://stackoverflow.com/a/19965089
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
    app.use(cors());
    app.use(nocache());


    // handle errors
    // see https://kostasbariotis.com/rest-api-error-handling-with-express-js/
    // app.use((error, request, response) => {
    //   /* We log the error internaly */
    //   console.error(error);

    //   /*
    //    * Remove Error's `stack` property. We don't want
    //    * users to see this at the production env
    //    */
    //   if (request.app.get('env') !== 'development') {
    //     delete request.stack;
    //   }

    //   /* Finaly respond to the request */
    //   response.status(error.statusCode || 500).json(error);

    //   response.status(error.status || 500);
    //   response.json({ error: error.message });
    // });


    //
    // Setup routes
    //
    const newsItemsRoute = newsItemsAPI(r, '/newsItems');
    app.use('/newsItems', newsItemsRoute);
    app.use('/storylines', storylineAPI(r, '/storylines'));
    app.use('/namedEntities', namedEntitiesAPI(r, '/namedEntities'));
    app.use('/logMessages', logMessagesAPI(r, '/logMessages'));
    app.use('/users', usersAPI(r, '/users'));
    app.use('/feeds', feedsAPI(r, '/feeds'));
    app.use('/feedGroups', feedGroupsAPI(r, '/feedGroups'));
    app.use('/queries', queriesAPI(r, '/queries'));
    app.use('/stories', storiesApi(r, '/stories'));
    app.use('/mediaItems', mediaItemsApi(r, '/mediaItems'));
    app.use('/feedback', feedbackAPI(r, '/feedback'));
    app.use('/taskProgress', taskProgressAPI(r, '/taskProgress'));
    app.get('/timestamp', async (req, res, next) => {
      const timestamp = await r.now().toEpochTime().round().run();
      res.status(200) // 200 – ok
        .json({ currentEpochTimeSecs: timestamp });
      next();
    });

    app.use('/videoChunks', (req, res, next) => {
      // console.log('/videoChunks', '\n', req.body);
      // console.log('forwarding to newsItems');
      // eslint-disable-next-line
      req.body.sourceItemVideoURL = url.resolve('http://livestream_cache_and_chunker:6000/', req.body.chunk_relative_url);
      next();
    }, newsItemsRoute);


    //
    // Start server
    //
    const server = app.listen(80, () => {
      const host = server.address().address;
      const port = server.address().port;

      console.log('App is listening on http://%s:%s', host, port);
    });


    // GRACEFUL SHUTDOWN
    // =============================================================================

    // this function is called when you want the server to die gracefully
    // i.e. wait for existing connections
    const gracefulShutdown = () => {
      console.log('Received kill signal, shutting down gracefully.');
      server.close(() => {
        console.log('Closed out remaining connections.');
        process.exit();
      });

      // if after
      setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit();
      }, 5 * 1000);
    };

    // listen for TERM signal .e.g. kill
    process.on('SIGTERM', gracefulShutdown);

    // listen for INT signal e.g. Ctrl-C
    process.on('SIGINT', gracefulShutdown);
  });
