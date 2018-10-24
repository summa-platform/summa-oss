#!/usr/bin/env python3

import os, sys, hashlib, logging
from multiprocessing import Process
from multiprocessing.sharedctypes import Value

# must be installed
import yaml

# must be installed
from serve_chunks import serve_chunks
from pull import HLSPull, run_pull
from storage import ChunkNotifier as ChunkNotifierBase


# config.yaml format:
# parallel_downloads: <number>
# chunk_extension: <string>
# active_feeds:
# - <active_feed_1>
# - ...
# feeds:
# - url1
# - url2
# - name: feed3
#   source_feed: url3
#   other_metadata: ...
#   ...
# - ...
# chunk_metadata_endpoint: url

logger = logging.getLogger(__name__)

class ChunkNotifier(ChunkNotifierBase):
    async def notify(self, path, start=None, end=None, next_path=None, prev_path=None, **kwargs):
        chunk_relative_url = os.path.join(self.metadata['id'], os.path.splitext(path)[0]+'.m3u8')
        prev_chunk_relative_url = os.path.join(self.metadata['id'], os.path.splitext(prev_path)[0]+'.m3u8') if prev_path else None
        next_chunk_relative_url = os.path.join(self.metadata['id'], os.path.splitext(next_path)[0]+'.m3u8') if next_path else None
        data = dict(self.metadata, chunk_relative_url=chunk_relative_url,
                prev_chunk_relative_url=prev_chunk_relative_url, next_chunk_relative_url=next_chunk_relative_url)
        await self.send(data)


def pull_worker(source_feed, root, chunk_metadata_endpoint, metadata, kwargs, stop):
    if chunk_metadata_endpoint is not None:
        chunk_notifier = ChunkNotifier(chunk_metadata_endpoint, metadata=metadata)
    else:
        chunk_notifier = None
    pull = HLSPull(source_feed, root, chunk_notifier=chunk_notifier, metadata=metadata, **kwargs)
    run_pull(pull)


if __name__ == "__main__":

    fmt = '%(asctime)s %(levelname)-8s [%(filename)s:%(lineno)d] %(message)s'
    logging.basicConfig(format=fmt, datefmt='%d-%m-%Y:%H:%M:%S',level=logging.DEBUG)

    import argparse

    # don't define defaults when calling add_argument below.
    # Values in the config file should override default values hard-coded here,
    # and arguments from the command line should override values given in the
    # config file. Therefore, we cannot set them in the argument specs for argparser,
    # because there wouldn't be a way to determine if they were set by the user
    # or by "default=..".
    parser = argparse.ArgumentParser(description='HLS Chunker (Storage and Serving)',
                                     formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument('--config', "-f", default="config.yaml", type=str, metavar='FILE',
                        help='configuration file')
    parser.add_argument('--data-dir', '-D', type=str, metavar='DIR',
                        help='data directory')
    parser.add_argument('--host', '-H', type=str, metavar="HOST",
                        help='host for Stored HLS Chunk HTTP server')
    parser.add_argument('--port', type=int, default=6000,
                        help='port for Stored HLS Chunk HTTP server')
    parser.add_argument('--prefix', type=str, 
                        help='prefix for segment URL')
    parser.add_argument('--full-path', action='store_true',
                        help='use full path addressing for segment URL')
    parser.add_argument('--chunk-size', metavar='SECONDS', type=int, default=5*60,
                        help='chunk size in seconds')
    parser.add_argument('--parallel-downloads','-j', type=int,
                        help='number of parallel downloads')
    args = parser.parse_args()

    try: # reading the config file
        logger.info('Loading configuration from: '+args.config)
        with open(args.config, 'r') as f:
            config = yaml.load(f)
    except FileNotFoundError:
        logger.critical('Configuration file not found: '+args.config)
        sys.exit(1)

    # NOW we set defaults for values not yet specified
    default_values = { "port": 6000,
                       "host": "0.0.0.0",
                       "chunk_size": 300, # in seconds, i.e. 5 minutes
                       "parallel_downloads" : 4 }
    for argmnt, dfltval in default_values.items():
        if not argmnt in args:
            args[argmnt] = config.get(argmnt,dfltval)
        
    jobs = []
    stop = Value('B', 0)

    active_feeds = config.get('active_feeds') or []
    feeds = config.get('feeds') or []
    is_active_feed = lambda feed, active_feeds: (feed.get('id') if type(feed) is dict else feed) in active_feeds
    feeds = [ f for f in feeds if is_active_feed(f, active_feeds) ]
    chunk_metadata_endpoint = config.get('chunk_metadata_endpoint')

    if not chunk_metadata_endpoint:
        logger.warning('No chunk metadata endpoint specified! (Check file %s). '%args.config+
                       'Will not notify anyone of new chunks.')

    if not feeds:
        logger.warning('No valid active feeds (Check file %s). '%args.config+
                       'Will only serve chunks from local storage')
    else:
        logger.info('Chunk metadata submission endpoint: %s'%chunk_metadata_endpoint)
        ids = set()
        for i,feed in enumerate(feeds):
            source_feed = feed.get('source_feed') if type(feed) is dict else feed
            if not source_feed or type(source_feed) is not str:
                logger.warning('Skipping feed configuration #%i: no valid source feed url' % i)
                continue
            # TO DO: Check if source feed URL is live. Warn and skip feed if not. - UG
            if type(feed) is not dict or not feed.get('id'):
                h = hashlib.md5()
                h.update(source_feed.encode('utf8'))
                id = h.hexdigest()
            else:
                id = feed.get('id')
            if id in ids:
                logger.warning('Duplicated feed id for feed configuration #%i' % i)
                continue
            ids.add(id)
            metadata = dict(feed, id=id) if type(feed) is dict else dict(source_feed=source_feed, id=id)
            specs = ','.join('%s=%s' % item for item in sorted(metadata.items(), key=lambda item: item[0]))
            logger.info('Adding feed #%i: %s %s'%(i,id,specs))

            # create job
            root = os.path.join(args.data_dir, id)
            kwargs = dict(ext='ts', parallel_downloads=args.parallel_downloads, chunk_size=args.chunk_size)
            job = Process(target=pull_worker, args=(source_feed, root, chunk_metadata_endpoint,
                                                    metadata, kwargs, stop))
            jobs.append(job)
            
    for job in jobs:
        job.start()

    serve_chunks(args.data_dir, args.host, args.port, args.prefix, args.full_path)

    # TODO: not implemented, add signal handler
    stop.value = 1

    for job in jobs:
        job.join()

    logger.info('All stopped!')
