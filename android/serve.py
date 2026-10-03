#!/usr/bin/python3
"""Serves the app's APKs to phones on the home network, for Obtainium or a
browser: python3 serve.py <folder> <port>. publish.sh puts them there."""

import functools
import http.server
import sys

folder, port = sys.argv[1], int(sys.argv[2])


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.apk': 'application/vnd.android.package-archive'}

    def end_headers(self):
        # Obtainium should always see the current list
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


http.server.ThreadingHTTPServer(('', port), functools.partial(Handler, directory=folder)).serve_forever()
