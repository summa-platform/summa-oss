#!/usr/bin/env python3

import os, sys
from urllib.parse import urljoin

# must be installed
from aiohttp import web

# monkey patch: https://github.com/KeepSafe/aiohttp/issues/860
from aiohttp.web_reqrep import StreamResponse
StreamResponse.set_tcp_nodelay = lambda self, value: None

import aiohttp_cors

# local
from yaml_storage import YAMLChunker
from index import HLSIndex


def get_chunk_index(path, base='', complete=False):
    if not path.lower().endswith('.yaml'):
        path += '.yaml'
    segments = YAMLChunker.read_chunk_segments(path, False)
    return HLSIndex.segments_to_index(segments, base, complete)

def data_file(data_dir):
    async def handler(request):
        try:
            id = request.match_info.get('id')
            path = request.match_info.get('path')
            path = os.path.join(data_dir, id, path)
            content_type = 'video/MP2T'
            with open(path, 'rb') as f:
                return web.Response(body=f.read(), content_type=content_type)
        except FileNotFoundError as e:
            print(e, file=sys.stderr)
            raise web.HTTPNotFound
        except Exception as e:
            print(e, file=sys.stderr)
            raise web.HTTPInternalServerError
    return handler

def chunk_index(data_dir, prefix='', root_path=True):
    async def handler(request):
        try:
            id = request.match_info.get('id')
            path = request.match_info.get('path')
            print('Generating chunk HLS index: %s/chunks/%s' % (id, path), file=sys.stderr)
            path = os.path.join(data_dir, id, 'chunks', os.path.splitext(path)[0]+'.yaml')
            content = get_chunk_index(path, urljoin(prefix, '/%s/' % id if root_path else ''), True).encode('utf8')
            content_type = 'application/x-mpegURL'
            return web.Response(body=content, content_type=content_type)
        except FileNotFoundError as e:
            print(e, file=sys.stderr)
            raise web.HTTPNotFound
        except Exception as e:
            print(e, file=sys.stderr)
            raise web.HTTPInternalServerError
    return handler

def serve_chunks(data_dir='', host='0.0.0.0', port=6000, prefix='', full_path=False):
    app = web.Application()
    cors = aiohttp_cors.setup(app, defaults={
        "*": aiohttp_cors.ResourceOptions(
                allow_credentials=True,
                expose_headers="*",
                allow_headers="*",
            )
    })
    if full_path:
        # root path segments
        cors.add(app.router.add_resource(r'/{id}/chunks/{path:.*.m3u8}').add_route('GET', chunk_index(data_dir)))
        cors.add(app.router.add_resource(r'/{id}/{path:.*.ts}').add_route('GET', data_file(data_dir)))
    else:
        # relative path segments
        cors.add(app.router.add_resource(r'/{id}/chunks/{path:.*.m3u8}').add_route('GET', chunk_index(data_dir, prefix, False)))
        cors.add(app.router.add_resource(r'/{id}/chunks/{date}/{path:.*.ts}').add_route('GET', data_file(data_dir)))
    web.run_app(app, host=host, port=port)


if __name__ == "__main__":

    import argparse

    parser = argparse.ArgumentParser(description='HLS Stored Stream Chunk Serving Service', formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument('--data-dir', metavar='DATADIR', type=str, default='', help='data directory')
    parser.add_argument('--host', type=str, default='0.0.0.0', help='host for HTTP server')
    parser.add_argument('--port', type=int, default=6000, help='port for HTTP server')
    parser.add_argument('--prefix', type=str, default='', help='prefix for segment URL')
    parser.add_argument('--full-path', action='store_true', help='use full path addressing for segment URL')

    args = parser.parse_args()

    serve_chunks(args.data_dir, args.host, args.port, args.prefix, args.full_path)
