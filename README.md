# shelf

Small self-hosted file sharing with a few editors, in a minimalist x11 look.
One Rust binary, one SQLite database, plain files on disk. The web UI is
included in the binary.

- users made by the admin; a home folder each
- upload (files and folders, drag and drop), download, rename, move, delete
- viewer: video/audio (with seeking), images, PDF, text, Markdown, CSV, ods,
  xlsx, RTF
- editors: Markdown (split preview), plain text (keeps its encoding and line
  endings), CSV grid, ods spreadsheets with simple formulas, sort and filter
  (saves by itself; xlsx is shown, turned into .ods to edit, and exported to), RTF
- folder sizes in the file list: everything inside, all the way down
- sharing with other users (read-only or read-write)
- public links to a file or folder, optional expiry
- external storage over SFTP, per user (password or key)
- nightly backup to an SFTP server; the backup is enough to rebuild the server
- metaplaces: "pictures", every picture a user can see in one grid by date,
  with a slideshow through all of them
- use from outside through a public edge, per account and only from listed
  networks (CIDR blocks or AS numbers)
- API keys: a program gets one folder, read-only or read-write, and can list,
  download, upload, move and delete there (share → API keys; see
  [docs/API.md](docs/API.md))

## Build and run

In /opt/shelf (the unit expects the binary there), as root:

    cargo build --release
    useradd -r -m -d /home/shelf -s /sbin/nologin shelf
    install -D -m 644 deploy/shelf.env.example /etc/shelf/shelf.env
    install -m 644 deploy/shelf.service /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now shelf
    sudo -u shelf SHELF_DATA=/home/shelf \
        target/release/shelf user add admin --admin --random

`user add --random` prints the generated password. You can also run
`shelf user passwd <name> [--random]`, `shelf user list` and `shelf backup …`. Everything
else is done in the web UI (admin → users).

Static files are included in the binary, so a change under `static/` needs a
rebuild. Asset URLs carry a content hash and are cached forever.

With SELinux enforcing, `deploy/selinux/install.sh` loads a module that runs
shelf, the edge tunnel (`deploy/shelf-tunnel`) and `android/serve.py` in
domains of their own, and labels their files. The units run `restorecon` on
their program before each start, since a rebuilt file comes out unlabelled.

## Configuration (`/etc/shelf/shelf.env`)

| variable | meaning |
|---|---|
| `SHELF_DATA` | data folder (default `/home/shelf`) |
| `SHELF_BIND` | listen address, e.g. `0.0.0.0:80` (the unit grants port 80 without root) |
| `SHELF_PUBLIC_URL` | absolute base for public links, once a front server exists |
| `SHELF_SECURE_COOKIE` | `1` when served over https (adds `Secure` to the cookie) |
| `SHELF_HOST` | name shown in the title bar |
| `SHELF_UPS_URL` | UPS status page (JSON) for the backup, see below |

No secrets go in this file. `SHELF_DATA/secret.key` is generated on first
start. It encrypts the SFTP passwords and keys stored in the database.

## Layout

    src/main.rs        config, CLI, router
    src/db.rs          schema, settings
    src/auth.rs        sessions (cookie `shelf`), CSRF header check, extractors
    src/users.rs       login, users, passwords (argon2)
    src/files.rs       ls / raw (GET with ranges, PUT with If-Match) / mkdir / rm / mv
    src/shares.rs      user shares and public links
    src/public.rs      /s/<token>… (no login)
    src/mounts.rs      SFTP mounts, credentials sealed with secret.key
    src/backup.rs      nightly backup
    src/sizes.rs       folder sizes, kept two minutes
    src/pictures.rs    pictures metaplace: index, dates, thumbnails
    src/edge.rs        the public edge's listener; outside networks, AS lookups
    src/sync.rs        one-way sync from phones: pairing, device tokens, uploads
    src/api.rs         API keys and the /api/v1 folder API (docs/API.md)
    src/vfs/           Backend trait; local disk and SFTP implementations
    src/md.rs          Markdown to sanitised HTML
    static/            x11.css/x11.js (shared theme), app, viewer, csv, sheet,
                       xlsx (engine, xlsx in and out), ods, rtf
    android/           the Android app: WebView and folder sync; serve.py and
                       publish.sh for the APK download on port 88
    docs/API.md        the folder API, for people writing programs against it

Data folder:

    shelf.db           SQLite (WAL)
    secret.key         32 bytes, 0600
    users/<name>/      home folders
    deleted/           files of deleted users, kept until removed by hand
    tmp/               partial uploads (renamed into place when complete)
    backup/            backup work area
    thumbs/            picture thumbnails (s/: grid, l/: slideshow); can be
                       deleted, they are made again

Every file operation goes through `vfs::Backend`, in `stat` / `list` / `open` /
`write` / `mkdir` / `remove` / `rename`. A location is `home`, `m<id>` (a
mount) or `s<id>` (a share); `files::resolve` turns it into a backend, a root
and a write flag. Paths are checked in `RelPath::parse`, which rejects `..`,
empty segments and control characters.

## Security notes

- Every non-GET `/api/*` request must carry the `x-shelf` header, which a
  cross-site form cannot send.
- Page CSP is `script-src 'self'`. User files are served with a sandbox CSP.
  HTML and XML are sent as text/plain, so an uploaded page cannot run as the
  app.
- Writes are atomic (temp file, then rename). Editors send `If-Match` with the
  ETag they loaded, so they cannot silently overwrite someone else's save.
- Public links are 128-bit random tokens. The sharer's account must stay
  enabled, and the link must not have expired.
- API keys are 256-bit random tokens (`shk_…`); only their sha256 is stored.
  `/api/v1` takes nothing but `Authorization: Bearer`, never the cookie, so it
  needs no `X-Shelf` header and cannot be reached cross-site. A key is bound to
  one folder (paths go through `RelPath`, joined below it), follows the folder
  when it moves, and ends with it, at expiry, on removal, or when the owner is
  disabled. Through the edge, the owner's outside networks apply.

## Spreadsheets (ods; xlsx, xlsm)

.ods is the format edited here. `static/sheet.js` is the CSV grid over the
workbook, `static/xlsx.js` the engine (zip, number formats, formulas, xlsx in
and out), `static/ods.js` reads and patches ods, all in the browser. Only the
cells that were edited are written back into content.xml, along with the
cached values of formulas that depend on them. Styles, merges, column widths,
other sheets and parts are copied through byte for byte.

- xlsx/xlsm files open read-only. "edit as .ods" writes `<name>.ods` next to
  it and opens that (if it exists: edit that one, replace it, or cancel).
  "new → spreadsheet (.ods)" makes an empty one. In the editor, "export .xlsx"
  downloads a copy or saves it next to the .ods.
- Sort a-z / z-a by the cursor's column: the selected rows, or else the block
  around the cursor up to empty rows. The header row and rows the filter
  hides stay put. Formulas move with their row, formats stay.
- Filter box: text anywhere in the row, or for one column (header name or
  letters) `col:text` (contains), `col!:text`, `col=x`, `col<>x`, `col<x`,
  `col>=x`…; several with `;` between, all have to match. Empty rows are
  hidden while filtering. The header checkbox says whether row 1 is a header;
  it is guessed when the sheet opens.
- Column filters, as in LibreOffice's autofilter: right click a cell (long
  press on a phone), the ▾ in the header, or alt+down. The menu sorts a-z /
  z-a, shows only or hides the clicked value, filters by condition (up to two,
  and/or: = <> > < contains, begins, ends, empty, largest/smallest n…), and
  lists the column's values with counts: values hidden now first, then an
  "all N others" box for everything past the first 50, then the first 50;
  the search box narrows the list (and the others box to what it found). The
  values counted are those of the rows the other filters let through.
  Filters live in the page, not in the file.
- The formula bar shows the cell as it was typed. Ctrl+D fills down. Copying
  cells and pasting them here moves their formulas along. Typed dates
  (`2026-01-02`, `1.10.26`, `14:30`) keep the format they were typed in.
- Functions: SUM PRODUCT AVERAGE MIN MAX COUNT COUNTA COUNTBLANK ROUND ROUNDUP
  ROUNDDOWN TRUNC INT ABS SIGN SQRT POWER MOD PI, IF IFERROR AND OR NOT ISBLANK
  ISNUMBER ISTEXT ISERROR, SUMIF COUNTIF, TODAY NOW DATE YEAR MONTH DAY,
  CONCATENATE CONCAT LEN LEFT RIGHT MID UPPER LOWER TRIM VALUE TEXT. Cross-sheet
  references work. A formula with another function keeps the value stored
  in the file while its inputs are unchanged, else shows `#NAME?`. It is then
  saved without a value, for LibreOffice to work out when it opens the file;
  an exported xlsx is marked to recalculate on open, for Excel.
- Rows and columns cannot be inserted or deleted (only rows added at the end),
  because every reference would have to move.
- It saves by itself every 5 s when something changed, when the tab is hidden
  and when leaving. The PUT carries `If-Match`. If someone else saved in
  between, their file is loaded, the cells edited here are laid on top and
  the save is tried again. With nothing edited here, their version just
  replaces what is shown (checked every 5 s while the tab is visible).
- No zip64, no encrypted or password-protected files, 32 MB at most. `.xls`
  is not read. Fraction formats (`# ?/?`) are not supported.

## Pictures (places → metaplaces → pictures)

Every picture in the user's home and in local folders shared with them (not
SFTP storage), newest first, in month groups; a click opens a slideshow
(arrows / swipe, space plays, back or esc closes). The places window folds to
its titlebar with a click on it, metaplaces and all; the choice is remembered.
Each place shows used/size of the disk it lives on (`75G/2.9T`, as in `df`),
dim below 80% full and bold in the normal text colour from there; SFTP storage
shows it when the server has the `statvfs@openssh.com` extension (OpenSSH
does). Asked at most once a minute per place.

- A scan runs at start, then about every 10 minutes and when the page is opened
  (at most every 2 minutes). Unchanged files are not read again. The index
  is the `pictures` table.
- The date is the EXIF date, else a date in the file name
  (`IMG_20250102_…`, `2025-01-02 13.14.15`, millisecond timestamps), else
  one in the folder (`2025-01-02`, or a year folder when the file time
  is outside that year), else the file time. The slideshow shows which one
  it used. EXIF and name dates are wall-clock times; the API sends them as if
  UTC.
- Hard links count once. Home copies win over shared ones, dated folders over
  albums.
- Grid thumbnails (320 px short side) are made ahead after each scan, one at a
  time; slideshow ones (1600 px long side) on request. JPEGs up to 1.5 MB and
  other formats go to the slideshow as they are. Unreadable files get an
  empty marker and a name-only tile.

## Outside access

With `SHELF_EDGE_BIND` set, the public edge reaches this server. An account can
be used through it only from its networks (admin → users → outside): CIDR
blocks, and AS numbers like `AS5610` for every network a provider announces
(handy for a phone on mobile data). The prefixes come from RIPEstat
(`stat.ripe.net`, announced-prefixes). They are fetched when the list is saved
and refreshed daily; a failed fetch keeps the previous list and is retried
hourly. The `asn_prefixes` table holds them. `shelf user remote <name> [cidr|AS<n> …]` does
the same from the shell.

## Phone sync (android app, settings → phones)

The app (`android/`) is shelf in a WebView that picks the home address on
Wi-Fi when shelf answers there, else the public one. Settings → phones lists
the paired phones; inside the app it also pairs this phone and manages its
folders.

- Pairing makes a device with a token of its own (`POST /api/devices`); the
  token can only list folders in the owner's home and put files there
  (`src/sync.rs`). Removing the phone in settings ends it.
- Folders are picked in Android's folder picker (DCIM/Camera,
  Pictures/Screenshots…; Android does not offer the storage root or Download
  itself) and each goes to a folder in the home, `Phone/<name>` unless changed.
- One way, never removing anything: new files are put, and files changed on
  the phone are put again with `If-Match`, only when nobody changed or removed
  them on shelf since. A file of the same name and size already there is taken
  as sent; a different one is left alone and listed as refused (try again
  after sorting it out). Hidden files (`.thumbnails`, `.trashed-…`,
  `.pending-…`) are skipped.
- It runs every hour and about 15 s to 2 minutes after a new picture or video,
  by default only on Wi-Fi; "sync now" runs in the foreground with a
  notification and uses any network. The phone keeps what it put where in
  `sync.db`.

Releases: `android/publish.sh` builds the signed APK (`SHELF_KEYSTORE`, see
`android/app/build.gradle.kts`) into `/srv/shelf-apk`, which
`android/serve.py <folder> <port>` can serve to the home network (open that
port to the LAN only). Obtainium: add `http://<server>:<port>/` as an app; the
page links only the newest APK. Raise `versionCode` and `versionName` for each
release. Set your addresses with `-PshelfLanUrl=http://…` and
`-PshelfPublicUrl=https://…` (and the LAN host in
`app/src/main/res/xml/network.xml`); `-PshelfUrl=http://…` builds one that
talks to a test shelf.

## Nightly backup (admin → nightly backup)

At the set time, the backup writes a complete snapshot to an SFTP server:

1. `VACUUM INTO` writes a consistent snapshot of the database. It runs on its
   own connection, so the app keeps serving and nothing is stopped.
2. A new folder `.partial-<time>` is filled with the database, `secret.key`,
   the systemd unit, the env file, the binary, all user files and a
   `manifest.json` (size, mtime and sha256 of each file). When it is complete,
   it is renamed to `<time>` (`YYYY-MM-DDTHHMMSS`, local time).
3. A file that is unchanged since the newest snapshot, or whose sha256 matches a
   file in any kept snapshot, is hard-linked (`hardlink@openssh.com`) instead of
   uploaded. Each distinct content is stored once. If the server cannot link,
   everything is uploaded and the run says so.
4. Three snapshots are kept: the newest, one up to a week older (1–7 days with
   nightly runs), and one one to four weeks older (8–29 days). Older ones are
   removed, together with any `.partial-*` left behind by a failed run.
   `backup::retain` has the rule, with a 200-night simulation in its tests.
   Only folders named like a snapshot are touched. Other files in the target
   folder are left alone.
5. `RESTORE.md` in the target folder lists the snapshots and the rebuild steps.
   On the target, files are 0600 and folders 0700.

A run can also be started by hand with `shelf backup run` (as the shelf user),
and a lock keeps it apart from the server's run. `shelf backup set --target
user@host:/folder --key < keyfile` sets the target from the shell, and
`shelf backup show` prints the state. The key is sealed with `secret.key` like
mount credentials.

With `SHELF_UPS_URL` set, shelf reads that page once in every five minutes, at
a random second. When it stops reading `on line power` (any value under
`status.flags`), a backup starts, once per outage. Old snapshots are removed
only while the page reads `on line power`; otherwise a run keeps them all and
notes the pruning as pending (`backup_prune_pending`, shown by `shelf backup
show`), and it happens at the first look that finds line power again. If the
page cannot be read for ten minutes, backups and pruning go on as without a
UPS.

The restore steps have been tested into a separate folder and port. Users,
public links, file checksums and the sealed SFTP credentials all came back.

Not included: contents of users' SFTP mounts (they live on their own servers).

## Later

**Public front server / cache.** Public pages and files live only under
`/s/<token>/…` and are served with `Cache-Control: public, no-cache` and an
ETag, so a caching proxy can keep them and revalidate cheaply. `/api/…` is
`no-store`, logged-in file downloads are `private`, and pages are `no-cache`.
The plan: proxy `/s/` (and `/static/`) from the public server to this
instance, set `SHELF_PUBLIC_URL` so copied links point there, and keep login
pages internal. If login is exposed too, serve it over https and set
`SHELF_SECURE_COOKIE=1`.

**WebDAV.** Map `PROPFIND`/`GET`/`PUT`/`MKCOL`/`DELETE`/`MOVE` under `/dav/` to
the same `Backend` + `resolve` (HTTP basic auth with app passwords). This
also lets OnlyOffice Desktop or any DAV client open files.

**OnlyOffice (WOPI or its own API).** Add `CheckFileInfo`/`GetFile`/`PutFile`
endpoints with short-lived per-file access tokens, on top of `open`/`write`
and the existing ETag check for locking. The document server needs to reach
this instance.

## Not done yet

- phone sync the other way (shelf to phone), and folders on an SD card
  were not tried
- zip download of folders
- trash for deleted files (the backup snapshots are the safety net)
- quotas

## License

Copyright (C) 2026 th3rumbl3m4t0r

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. See [LICENSE](LICENSE).
