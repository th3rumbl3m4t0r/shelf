# shelf folder API

A shelf user can give a program one of their folders: a backup script, a
photo frame, a sync tool, an AI agent. The program gets an **API key** for that
folder and can then list, download and, if the key may edit, upload, replace,
move and delete files in it. It cannot see or reach anything outside that
folder, and it never gets the user's password.

- [Getting a key](#getting-a-key)
- [Basics](#basics): base URL, authentication, paths, errors
- [Endpoints](#endpoints)
- [Changing files safely](#changing-files-safely): ETags, `If-Match`
- [Examples](#examples): curl, Python
- [Limits and behaviour](#limits-and-behaviour)

## Getting a key

In the web UI, open **share** on a folder (in the file list), and under
**API keys** enter a name for what will use it, tick **can edit** if it may
change things, optionally set an expiry in days, and press **create key**.

The key is shown **once**. shelf only keeps a hash of it, so copy it then. If
it is lost, make a new one and remove the old one.

A key:

- is for one folder in your home or on one of your SFTP storages, not for the
  whole location, and not for folders others shared with you;
- is read-only, or read-write ("can edit");
- follows its folder when the folder is renamed or moved, and ends when the
  folder is deleted;
- stops working when it expires, when you remove it (share dialog, or
  **settings → API keys**, which lists all of them with when each was last
  used), or when your account is disabled.

Keys look like `shk_` followed by 43 characters (256 random bits). Treat one
like a password: anyone who has it has the folder.

## Basics

### Base URL

    http://<shelf server>/api/v1

At home that is the address you open shelf at, for example
`http://shelf.lan/api/v1`. From outside, through the public edge, it is the
public address (`https://…/api/v1`). Outside access works only if the account
may be used from the network the program is on (an admin sets that with
**outside** on the user, in admin → users); otherwise every request gets `403`.

### Authentication

Every request carries the key:

    Authorization: Bearer shk_...

Nothing else is accepted on `/api/v1`: no cookies, no query parameter. A
missing, unknown, expired or removed key gets `401`. No `X-Shelf` header is
needed (the web UI needs it, the API does not).

### Paths

Paths are relative to the key's folder. `/` (or nothing) is the folder itself;
`/photos/2026/a.jpg` is a file two folders down. In URLs, put the path after
the endpoint and percent-encode each segment the usual way (a space is `%20`,
`#` is `%23`, `?` is `%3F`, non-ASCII as UTF-8 bytes):

    GET /api/v1/file/notes/meeting%20notes.md

`..` and `.` segments, empty segments and control characters are refused with
`400`, so a path can never leave the folder. Names are case sensitive and at
most 255 bytes.

### Entries

Listings and write operations describe files and folders as:

```json
{
  "name": "a.txt",
  "path": "/docs/a.txt",
  "dir": false,
  "size": 1234,
  "mtime": 1790943194,
  "etag": "\"4d2-6abf9fda-3a101de3\""
}
```

| field | meaning |
|---|---|
| `name` | last segment of the path |
| `path` | path inside the key's folder, starting with `/` |
| `dir` | `true` for a folder |
| `size` | bytes (0 for folders) |
| `mtime` | modification time, seconds since 1970 (UTC) |
| `etag` | version tag, quotes included; changes whenever the file does. Send it back as is in `If-Match` |

### Errors

Errors have a status code and a JSON body with a message meant for people:

```json
{ "error": "the file changed or is gone (If-Match)" }
```

| status | when |
|---|---|
| `400` | bad path or request, a file where a folder is needed or the other way round |
| `401` | no key, or the key is unknown, expired or removed |
| `403` | the key is read-only and the request would change something; or outside access is not allowed from this network |
| `404` | no such file or folder |
| `409` | something is in the way: the target exists, the folder is not empty |
| `412` | an `If-Match` / `If-None-Match` condition failed |
| `416` | a `Range` outside the file |
| `502` | the SFTP storage behind the folder failed or cannot be reached |

## Endpoints

| method and path | what | needs edit |
|---|---|---|
| `GET /api/v1` | the key itself | |
| `GET /api/v1/list[/<folder>]` | entries of a folder | |
| `GET /api/v1/file/<path>` | download a file (`HEAD` too) | |
| `PUT /api/v1/file/<path>` | upload: create or replace a file | yes |
| `DELETE /api/v1/file/<path>` | delete a file or folder | yes |
| `POST /api/v1/mkdir/<path>` | make a folder | yes |
| `POST /api/v1/move` | rename or move | yes |

### `GET /api/v1`

What the key is. Handy to check a key before using it.

```json
{
  "name": "backup script",
  "user": "alice",
  "folder": "projects",
  "write": true,
  "expires": null,
  "version": "0.1.0"
}
```

`expires` is seconds since 1970, or `null` for never.

### `GET /api/v1/list[/<folder>]`

The entries of a folder, sorted by name:

```json
{
  "path": "/",
  "entries": [
    { "name": "a.txt", "path": "/a.txt", "dir": false, "size": 6, "mtime": 1790943194, "etag": "\"6-6abf9fda-3a101de3\"" },
    { "name": "sub", "path": "/sub", "dir": true, "size": 0, "mtime": 1790943194, "etag": "\"0-6abf9fda-3a012bdb\"" }
  ]
}
```

| query | |
|---|---|
| `recursive=1` | everything below the folder, all the way down (up to 32 levels). Each folder's entries are sorted by name; the order of folders is not defined, so use `path`. More than 100,000 entries is a `400`: list folder by folder then |

A file instead of a folder is a `400`.

### `GET /api/v1/file/<path>`

The file's bytes, with `Content-Type` guessed from the name, `Content-Length`,
`ETag` and `Last-Modified`. Standard HTTP works:

- `Range: bytes=0-1023` gives `206 Partial Content` (resume a download, read
  part of a big file); `If-Range` is honoured;
- `If-None-Match: <etag>` gives `304 Not Modified` when you have that version;
- `HEAD` gives the headers only, to check size and version cheaply.

HTML and XML come back as `text/plain`, and other types that could run script
(SVG, for one) with a sandboxing `Content-Security-Policy`, so a file can never
act as a web page on the shelf server. The bytes are unchanged either way.

### `PUT /api/v1/file/<path>`

Creates the file, or replaces it if it exists. The request body is the new
content, sent as is (not a form, not JSON); any size; it is streamed to disk.
Readers never see a half-written file: the new version replaces the old one
in one step once it is complete, and an upload that breaks off leaves the old
version as it was.

| header | |
|---|---|
| `If-Match: <etag>` | replace only that version; `412` if the file changed since (or is gone). `If-Match: *`: only replace an existing file |
| `If-None-Match: *` | only create; `412` if the file exists |

| query | |
|---|---|
| `mkdirs=1` | make missing folders on the way. Without it, uploading into a folder that does not exist is a `404` |
| `mtime=<seconds>` | set the file's modification time, e.g. to keep the original's |

Answers `201 Created` for a new file, `200 OK` for a replaced one, with the
file's entry (and its new `etag`). Uploading over a folder is a `400`.

### `DELETE /api/v1/file/<path>`

Deletes a file, or an empty folder. There is no trash: deleted is gone (only
shelf's nightly backups have it). Shares and links on what is deleted go with
it.

| | |
|---|---|
| `?recursive=1` | delete a folder with everything in it. Without it, a folder that is not empty is a `409` |
| `If-Match: <etag>` | delete a file only if it is still that version; `412` otherwise (and for folders) |

The key's own folder cannot be deleted. Answers `{"ok": true}`.

### `POST /api/v1/mkdir/<path>`

Makes a folder. `409` if something of that name exists, `404` if the folder
it would go in does not.

| query | |
|---|---|
| `parents=1` | also make missing folders above it, and no error if the folder is already there (like `mkdir -p`) |

Answers `201 Created` with the folder's entry.

### `POST /api/v1/move`

Renames or moves a file or folder inside the key's folder. JSON body:

```json
{ "from": "/drafts/report.md", "to": "/done/2026-10 report.md" }
```

Both paths are relative to the key's folder. The folder `to` goes in must
exist. Fails with `409` if `to` exists: nothing is overwritten (delete it
first, or upload over it instead). A folder cannot go into itself, and the
key's own folder cannot be moved. Shares and links on what moved follow it.
Answers with the entry at `to`.

## Changing files safely

Other people, the web UI and other programs may change the same files. To
edit a file without losing someone else's change:

1. `GET` the file and keep its `ETag` header (or the `etag` from a listing).
2. Change it locally.
3. `PUT` it back with `If-Match: <that etag>`.
4. On `412`, someone changed it in between: fetch it again, redo the change,
   try again (or tell your user).

The web UI's editors work the same way, so they and your program will not
silently overwrite each other. For "create, but never overwrite", use
`If-None-Match: *`.

The check happens right before the write; two writers racing within the same
instant are not excluded, as with most HTTP file servers.

## Examples

### curl

```sh
S=http://shelf.lan/api/v1
K="Authorization: Bearer shk_..."

curl -H "$K" $S                                   # what is this key
curl -H "$K" "$S/list"                            # top of the folder
curl -H "$K" "$S/list/photos?recursive=1"         # everything under photos/
curl -H "$K" -o a.jpg "$S/file/photos/a.jpg"      # download
curl -H "$K" -C - -o big.iso "$S/file/big.iso"    # resume a download
curl -H "$K" -T report.pdf "$S/file/inbox/report.pdf?mkdirs=1"     # upload
curl -H "$K" -T notes.md -H 'If-None-Match: *' "$S/file/notes.md"  # only if new
curl -H "$K" -X POST "$S/mkdir/archive/2026?parents=1"
curl -H "$K" -H 'content-type: application/json' \
     -d '{"from": "/inbox/report.pdf", "to": "/archive/2026/report.pdf"}' "$S/move"
curl -H "$K" -X DELETE "$S/file/archive/2026/report.pdf"
curl -H "$K" -X DELETE "$S/file/old-stuff?recursive=1"
```

`curl -T file URL` sends a `PUT` with the file as the body.

### Python (standard library only)

```python
import json, urllib.error, urllib.parse, urllib.request

BASE = "http://shelf.lan/api/v1"
KEY = "shk_..."

def call(method, path, query="", body=None, headers=None):
    """path is encoded here; query ("recursive=1") is added as is."""
    url = BASE + urllib.parse.quote(path) + ("?" + query if query else "")
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Authorization": "Bearer " + KEY, **(headers or {})})
    with urllib.request.urlopen(req) as r:
        return r.read(), r.headers

def append_line(path, line):
    """Adds a line to a text file without losing changes made meanwhile."""
    while True:
        data, h = call("GET", "/file" + path)
        try:
            call("PUT", "/file" + path, body=data + line.encode() + b"\n", headers={"If-Match": h["ETag"]})
            return
        except urllib.error.HTTPError as e:
            if e.code != 412:   # 412: changed since we read it, so read again
                raise

listing = json.loads(call("GET", "/list", "recursive=1")[0])
for e in listing["entries"]:
    print("d" if e["dir"] else "-", e["size"], e["path"])
append_line("/log.txt", "backup done")
```

## Limits and behaviour

- Only the key's folder and what is below it. shelf itself never makes
  symbolic links; ones an admin placed in a home on the server are followed,
  as in the file list.
- No size limit on uploads beyond free space. Large uploads stream; nothing is
  held in memory.
- Moves stay inside the key's folder; to copy a file, download and upload it.
- Write requests through the public edge are not cached; downloads there are
  passed through, not cached either.
- No CORS headers: the API is for programs, not for scripts in other web
  pages.
- Keys only work while the folder exists: a deleted folder takes its keys
  along, and a folder made again with the same name needs a new key.
