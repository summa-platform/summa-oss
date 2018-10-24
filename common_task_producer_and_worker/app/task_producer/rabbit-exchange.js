/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import amqp from 'amqplib';
import async from 'async';
import _ from 'underscore';
import { getTaskId } from '../common/task';

// class for sending messages to rabbit exchange
// the class contains an internal queue
// where messages are stored in case the rabbit connection
// is not online. The class will attempt to recconect
// and resend message

export default class Rabbit {
  constructor(address, workerExchangeName, resultExchangeName, routingKeys, debug) {
    this.address = address;
    this.channel = null;


    // global var for storing items
    // that have been sent but not acked
    // if some error occures while in transit
    // than place the item back into queue
    this.itemInTransit = null;


    this.sendItemToRabbit = (item, callback) => {
      if (this.channel) {
        // debug(`[INF] sending ${getTaskId(item)}`);

        if (this.itemInTransit !== null) {
          const error = new Error('should never send while something in transit');
          debug('[ERROR] send while something in transit', error);
          console.error('[ERROR] send while something in transit', error);
          throw error;
        }
        this.itemInTransit = [item, callback];

        const payload = new Buffer(JSON.stringify(item.payload));
        const routingKey = item.routingKey
                           ? `${workerExchangeName}.${item.routingKey}`
                           : workerExchangeName;
        const fullRoutingKeyBase = `SUMMA-RESULTS.${resultExchangeName}`;
        // console.log(`!!! publishing to '${exchangeName}' under '${routingKey}'`);
        const resultRoutingKeys = {
          // FIXME for now using the same for all
          finalResult: `${fullRoutingKeyBase}.finalResult`,
          partialResult: `${fullRoutingKeyBase}.partialResult`,
          processingError: `${fullRoutingKeyBase}.processingError`,
        };
        this.channel.publish(workerExchangeName, routingKey, payload,
          {
            headers: {
              replyToExchange: 'SUMMA-RESULTS',
              replyToRoutingKeys: resultRoutingKeys,
            },
          },
          (err) => {
            if (err !== null) {
              debug(`[WARN] send failed; placing ${getTaskId(item)} back into queue`, err); // Message nacked!
              callback(err);
            } else {
              debug(`[INF] done sending ${getTaskId(item)}`); // Message acked!
              callback(err);
            }
          },
        );
      } else {
        debug(`[WARN] channel not ready; place back ${getTaskId(item)}`);
        callback(new Error('channel not ready'));
      }
    };

    const maximumConcurency = 1;
    this.sendToRabbitExchange = async.queue(this.sendItemToRabbit, maximumConcurency);
    this.sendToRabbitExchange.pause();


    const channelReady = (ch) => {
      debug('[INF] channelReady');
      this.channel = ch;
      this.sendToRabbitExchange.resume();
    };

    let connect;
    const tryReconnect = (err) => {
      this.channel = null;
      this.sendToRabbitExchange.pause();
      if (this.itemInTransit !== null) {
        debug('[WARN] connection failure; placing item back into local queue', this.itemInTransit[0]);
        const [, callback] = this.itemInTransit;
        callback(new Error('connection failure'));
      }
      debug('[INF] tryReconnect in 3s; recovery from error', err);
      setTimeout(connect, 3000);
    };

    const connectionEstablishedCallback = async (connection) => {
      debug('[INF] connection established');

      connection.on('error', tryReconnect);

      const ch = await connection.createConfirmChannel();
      debug('[INF] channel open');

      await ch.assertExchange(workerExchangeName, 'topic', { durable: false });
      debug('[INF] exchange asserted');

      if (_.isEmpty(routingKeys)) {
        // create default queue => exchangeName
        const route = workerExchangeName;
        const queueName = route;
        const queue = await ch.assertQueue(queueName, { durable: false });
        console.log('binding queue', queueName);
        await ch.bindQueue(queue.queue, workerExchangeName, route);
      } else {
        // create queues for each routingKey => exchangeName.routingKey
        for (let routingKey of routingKeys) {
          const route = `${workerExchangeName}.${routingKey}`;
          const queueName = route;
          const queue = await ch.assertQueue(queueName, { durable: false });
          console.log('binding queue', queueName);
          await ch.bindQueue(queue.queue, workerExchangeName, route);
        }
      }

      channelReady(ch);
      return ch;
    };

    connect = () => {
      amqp.connect(this.address)
        .then(connectionEstablishedCallback, tryReconnect)
        .catch((error) => {
          // all exceptions should have been caught and handle above
          debug('[ERROR] unexpected connection error', error);
          console.error('[ERROR] unexpected connection error', error);
          const err = new Error(`should have never been here ${error}`);
          throw err;
        });
    };

    connect();
  }

  push(item, sendDone) {
    const handleError = (err) => {
      this.itemInTransit = null; // clean up
      if (err) {
        this.sendToRabbitExchange.unshift(item, handleError);
      } else if (sendDone) {
        sendDone();
      }
    };
    this.sendToRabbitExchange.push(item, handleError);
  }
}
