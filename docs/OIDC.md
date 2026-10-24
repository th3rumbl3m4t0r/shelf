# Sign-in with shelf (OpenID Connect)

shelf can be the login of other programs on the network: a program sends the
browser to shelf, the person logs in there (or already is), and the program
gets back who they are. This is OpenID Connect, so any program or library
that speaks it works: oauth2-proxy in front of a site that has no login of its
own, Grafana, Gitea, a Flask or axum app of your own, a phone app.

- [Turning it on](#turning-it-on)
- [Adding a program](#adding-a-program)
- [What a program needs](#what-a-program-needs)
- [Example: oauth2-proxy in front of nginx](#example-oauth2-proxy-in-front-of-nginx)
- [Example: your own program](#example-your-own-program)
- [Limits](#limits)

## Turning it on

In `/etc/shelf/shelf.env`, set the address browsers and programs reach shelf
at, without a path, and restart shelf:

    SHELF_OIDC_ISSUER=http://shelf.lan

This is the *issuer*. It has to be exactly the same everywhere: in the tokens,
in the discovery document and in each program's settings. On the first start
with it, shelf makes its signing key (an RSA key, kept sealed in the
database, so the backup has it). Sign-in answers only on the LAN listener,
never through the public edge.

## Adding a program

Admin → **sign-in for other programs** → **add program**, or from the shell:

    runuser -u shelf -- env SHELF_DATA=/home/shelf \
        /opt/shelf/target/release/shelf oidc add tracker \
        --redirect http://apps.lan/oauth2/callback [--users alice,bob] [--public]

- **name**: the program's `client_id` (a-z 0-9 . _ -). It cannot be renamed.
- **redirect URIs**: where shelf may send the browser back to, one per line.
  They are matched exactly, query included. The program's documentation says
  what its callback address is.
- **who may log in**: usernames; empty means every account. Someone else gets
  `access_denied`.
- **public**: for an app that cannot keep a secret (on a phone, or all in the
  browser). It gets no secret and has to use PKCE. Everything else gets a
  **client secret**, shown once. If it is lost, **new secret** makes another
  one and the old one stops working.

Removing a program ends every token it was given. So do changing a password
and disabling an account, for that person's tokens.

## What a program needs

| setting | value |
|---|---|
| issuer / discovery | `http://shelf.lan`, discovery at `http://shelf.lan/.well-known/openid-configuration` |
| client_id, client_secret | from the admin page |
| scopes | `openid profile` (others are ignored) |
| flow | authorization code; PKCE S256 recommended, required for public clients |
| client authentication | `client_secret_basic` or `client_secret_post`; `none` for public clients |
| signing | RS256 (key in `/oidc/jwks`) |
| user name claim | `preferred_username` (the shelf username) |
| user id claim | `sub`: random per account and never reused, the right one to store |

Programs that find things through the discovery document need only the first
three rows. For the others, the endpoints are:

| | |
|---|---|
| authorization | `http://shelf.lan/oidc/authorize` |
| token | `http://shelf.lan/oidc/token` |
| userinfo | `http://shelf.lan/oidc/userinfo` |
| keys (JWKS) | `http://shelf.lan/oidc/jwks` |

The ID token has `iss`, `sub`, `aud`, `azp`, `iat`, `exp`, `auth_time`,
`nonce` (when sent) and `at_hash`, and with scope `profile` also
`preferred_username` and `name`. Userinfo answers `sub`, `preferred_username`
and `name` for the access token.

ID and access tokens last an hour. Every code exchange also gives a refresh
token, good for 30 days. Each one works once and the answer brings the next
one. A code works once, within 60 seconds, from the redirect URI it was asked
for. If someone uses a code twice, the tokens it gave are revoked.

`prompt=login` and `max_age` make the person log in again. `prompt=none`
never shows the login page and answers `login_required` instead. The answer
on the redirect URI carries `iss` (RFC 9207) besides `code` and `state`.

There is no consent page. The programs are the admin's own, so a person who
is logged in to shelf goes straight back with a code.

## Example: oauth2-proxy in front of nginx

For sites without a login of their own (cgit, a tracker, a status
page), oauth2-proxy can do the OpenID Connect part and nginx asks it about
each request (`auth_request`). One program in shelf covers every site behind
that nginx.

In shelf: add a program `apps` with the redirect URI
`http://apps.lan/oauth2/callback`.

`/etc/oauth2-proxy.cfg` on that host:

    provider = "oidc"
    oidc_issuer_url = "http://shelf.lan"
    client_id = "apps"
    client_secret = "<from shelf>"
    redirect_url = "http://apps.lan/oauth2/callback"
    scope = "openid profile"
    code_challenge_method = "S256"
    # shelf has no email addresses; the username stands in for one
    oidc_email_claim = "preferred_username"
    email_domains = ["*"]
    http_address = "127.0.0.1:4180"
    reverse_proxy = true
    set_xauthrequest = true
    skip_provider_button = true
    upstreams = ["static://202"]
    # plain http on the LAN
    cookie_secure = false
    cookie_secret = "<python3 -c 'import os,base64; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'>"

nginx, in the server block:

    location /oauth2/ {
        proxy_pass http://127.0.0.1:4180;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Auth-Request-Redirect $request_uri;
    }
    location = /oauth2/auth {
        proxy_pass http://127.0.0.1:4180;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Content-Length "";
        proxy_pass_request_body off;
    }

and in each location to protect:

    auth_request /oauth2/auth;
    error_page 401 = /oauth2/sign_in;
    # who it is, for the program behind
    auth_request_set $user $upstream_http_x_auth_request_preferred_username;
    proxy_set_header X-User $user;

Leave out locations that programs call rather than people, such as an API an
app uses or a status probe. Otherwise they get a login page instead of their
answer.

## Example: your own program

Any OpenID Connect library works. With Authlib in Flask:

    oauth.register("shelf", client_id="tracker", client_secret="…",
                   server_metadata_url="http://shelf.lan/.well-known/openid-configuration",
                   client_kwargs={"scope": "openid profile", "code_challenge_method": "S256"})

    @app.route("/login")
    def login():
        return oauth.shelf.authorize_redirect(url_for("callback", _external=True))

    @app.route("/callback")
    def callback():
        user = oauth.shelf.authorize_access_token()["userinfo"]
        session["user"] = user["preferred_username"]   # store user["sub"] to recognise them
        return redirect("/")

## Limits

- Over plain http on the LAN, like the rest of shelf there: anyone who can
  watch the network can read codes and tokens, as they can passwords.
- No email addresses and no groups; who may use a program is set per program.
- No logout endpoint: logging out of a program ends that program's session,
  not the one in shelf.
- No implicit or hybrid flow, no request objects, no dynamic client
  registration, no consent page.
- One signing key, never rotated. Removing `oidc_key` from the `settings`
  table and restarting makes a new one; programs pick it up from the JWKS.
