/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import cluster from 'cluster';
import startClusterMaster from './cluster_master';
import startClusterWorker from './cluster_worker';
import { integrationDebug, getTaskDebugFn } from './common/debuggers';


if (cluster.isMaster) {
  integrationDebug('[INF] Starting master process');
  startClusterMaster();
} else {
  const workerTaskPath = process.env.WorkerTask;
  getTaskDebugFn(workerTaskPath)(`[INF] Starting slave process using ${workerTaskPath}`);
  startClusterWorker(workerTaskPath);
}
