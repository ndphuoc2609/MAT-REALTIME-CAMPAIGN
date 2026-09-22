# Admicro reports

One-server report collection with administrator and viewer accounts. Administrators manage source links, sync jobs, source profiles, and viewer grants. Viewers can read stored reports only for sources an administrator explicitly grants. Source passwords and cookies are never accepted by the app API.

PostgreSQL is the sole store for report links, snapshots, jobs, schedule settings, users, sessions, and report grants. `DATABASE_URL` must be a valid PostgreSQL connection URL; the app and database CLI commands fail clearly when it is missing or invalid. There is no SQLite-to-PostgreSQL import: old `links.sqlite` and `auth.sqlite` files are left untouched and never read. Browser profiles remain files under `DATA_DIR/sessions/<source>` and are reused for headless crawls. Manual source sessions remain the default. The 24h connector and Admicro PC/Mobile connectors can use their documented source credentials for unattended login; credentials are read only by the backend login flow and are never returned or logged.

## Local run

Requires Node.js 22.13+, npm, and a PostgreSQL database. Before running app or admin commands, provide `DATABASE_URL` through the process environment or an untracked `.env` file.

```sh
npm ci
npx playwright install chromium
npm run admin:create -- report-admin
HOST=127.0.0.1 npm start
```

The first-admin command prompts twice for a password without echoing it. Passwords must be at least 14 characters. There are no default credentials. If an administrator already exists, bootstrap is refused. Open `http://127.0.0.1:8787` and sign in.

To reset an existing administrator, run `npm run admin:reset-password -- report-admin` with the same `DATABASE_URL` as the app. It prompts twice without echoing the password, requires at least 14 characters, and revokes all existing sessions for that administrator.

Operational settings can be supplied in the process environment or `.env`: `PORT`, `APP_PORT` (Compose), `HOST`, `DATA_DIR`, `DATABASE_URL`, `SYNC_INTERVAL_MINUTES`, `HOUSEKEEPING_ENABLED`, `HOUSEKEEPING_INTERVAL_MINUTES`, `HOUSEKEEPING_SNAPSHOT_RETAIN`, `HOUSEKEEPING_JOB_RETENTION_DAYS`, `HOUSEKEEPING_CACHE_ENABLED`, `TRUST_PROXY`, `COOKIE_SECURE`, `PUBLIC_ORIGIN`, and `CHROME_BIN`. Store the database URL only in an untracked `.env` or your hosting provider's secret settings; never commit it or print resolved Compose configuration. `.env.example` contains placeholders only.

## One-server deployment

The included Compose setup requires `DATABASE_URL` and passes it to the app. Put the PostgreSQL connection URL in the server environment or an untracked project `.env` file. The `./data` volume stores persistent browser profiles; old SQLite database files are never read. Choose the unprivileged host account that owns the profile directory and start the stack from the project directory:

```sh
export APP_UID="$(id -u)"
export APP_GID="$(id -g)"
docker compose -f compose.yml build
docker compose -f compose.yml up -d
```

Compose publishes the app directly at `http://<server>:${APP_PORT:-8787}`. Set `APP_PORT` in the server environment or untracked `.env` when another host port is required. Direct access leaves `TRUST_PROXY=0`; set it to `1` only when placing the app behind a separately managed trusted reverse proxy, and configure `COOKIE_SECURE=1` or TLS termination there as appropriate.

Run one app instance only. The worker queue and scheduler remain in-memory and
single-process. Browser profile operations also use a kernel file lock, so CLI
login/import and another local process sharing the same `DATA_DIR` wait or fail
closed instead of opening the profile concurrently. The lock requires a shared
local filesystem with `python3`/`fcntl`; NFS and filesystems without reliable
kernel locks are unsupported. Multiple app replicas remain unsupported because
the queue and scheduler do not share a distributed lease.

Create the first administrator after the app is healthy:

```sh
docker compose -f compose.yml exec app npm run admin:create -- report-admin
```

Create viewers and assign only the required reports:

```sh
docker compose -f compose.yml exec app npm run user:create -- analyst viewer
docker compose -f compose.yml exec app npm run grant:reports -- --list
docker compose -f compose.yml exec app npm run grant:reports -- analyst SOURCE_ID_1 SOURCE_ID_2
```

The last command replaces that viewer’s grants. Pass only the username to revoke all of their report access. Administrators can make the same changes from **Quyền xem** in the app. New viewer accounts receive no reports until grants are assigned.

Automatic collection is enabled by default and runs daily at **02:00 Asia/Ho_Chi_Minh**. Administrators can choose the daily time and turn automation on or off in **Công việc**; schedule settings and the durable single-worker job queue are stored in PostgreSQL. A missed run after restart is caught up once for that local calendar date. On startup, eligible sources without snapshots are also queued even when older schedule metadata exists. A complete source added or edited by an administrator is queued automatically. Imported pending session candidates can be tried by automatic work and are promoted only after the existing successful-report check. Manual **Lấy dữ liệu** and **Lấy tất cả** remain available.

`SYNC_INTERVAL_MINUTES` remains as an environment compatibility setting for the initial enabled state: positive values (Compose defaults to `1440`) start automation enabled, while `0` initializes it as disabled. An administrator can enable or disable it later in the Jobs panel; that setting persists in the selected database across restarts. The time of day never needs to be configured in `.env`. Queued work resumes after restart; a job interrupted while running is marked failed and can be started again from its source card. Recognized network errors and timeouts receive at most two retries with 1- and 2-second backoff. Authentication, schema, inspection, and HTTP-access failures are not retried. Only a fully reconciled collect replaces the stored snapshot; failed or partial collects keep the prior snapshot. SIGTERM stops scheduling, closes active Playwright contexts, and closes the database pool before the container exits.

Housekeeping is enabled by default and runs every six hours when the in-memory queue, active worker, and persisted sync jobs are idle. It keeps the latest three snapshots for each link/scope, removes only terminal sync jobs older than 90 days, and removes known rebuildable Chromium cache directories. It keeps the active profile, pending promotion files, lock/journal files, cookies, local storage, and the newest profile backup; invalid housekeeping configuration disables cleanup without stopping the app. Compose bounds Docker JSON logs for the app at 10 MB per file with three rotated files.

`/healthz` is an unauthenticated liveness check and returns only `{ "status": "ok" }`. Login attempts are limited to five per IP per 15 minutes. Sessions use a random HttpOnly, SameSite=Strict cookie, expire after 24 hours, and require a per-session CSRF token and same-origin request for every state-changing API call. Viewer source grants are enforced on both report lists and direct report-detail requests. Report API responses omit source query strings and recursively strip raw `extra` payloads. Protect browser profiles and database credentials as secrets.

## Source sessions

For manual sessions, log in directly with the provider and do not put source
passwords or cookies in chat or the browser API. The unattended 24h flow may
read the three documented `SOURCE_24H_*` values from the server secret store
or untracked `.env`; they are never logged or returned. On a workstation with
a browser display, use a private working data directory and refresh the
provider profile:

```sh
DATA_DIR="$PWD/session-work" npm run session:login -- 24h
DATA_DIR="$PWD/session-work" npm run session:state -- export 24h "$PWD/24h-state.json"
chmod 600 24h-state.json
```

The browser opens the provider page. Sign in there, return to the terminal, and press Enter. The export validates that cookies and local storage belong to the selected provider, creates a new file with mode `0600`, and refuses to overwrite an existing file. It does not prove that the provider will accept the session on the server.

Transfer the state file over SSH/SFTP to the server and keep it private. For Compose, import it with a one-off app container:

```sh
docker compose -f compose.yml run --rm --no-deps \
  -v "$PWD/24h-state.json:/tmp/source-state.json:ro" \
  app npm run session:state -- import 24h /tmp/source-state.json
```

The importer requires a private file (`chmod 600`), validates its provider domains, and stages it as a pending candidate without changing the active profile. It applies cookies and local storage to that separate profile, so the app can remain running and scheduled crawls continue using the active profile. The next automatic scheduled run or admin-triggered sync can try the candidate; only after a report has been successfully read does the app promote it and retain the previous active profile under a timestamped backup name. Authentication, network, schema, or partial-read failures leave the active profile and pending candidate available. The profile lock serializes simultaneous imports for the same connector. Remove the transferred state file securely when it is no longer needed. For a native deployment, run the same import command with the same `DATA_DIR` used by the server.

The current transfer covers cookies and local storage; it does not claim to transfer every browser-only authentication mechanism. If a provider requires state outside that format, its authentication workflow needs separate verification. The app has not live-verified a 24h or FPT session as part of this deployment work. The public 24h form does not expose a verified account-identity field; a successful authorized complete report read is the available permission evidence.

For unattended 24h collection, configure `SOURCE_24H_USERNAME`,
`SOURCE_24H_PASSWORD`, and `SOURCE_24H_AUTO_LOGIN=true` in the server runtime
environment (or untracked `.env`), then restart the app. If the provider
rejects the credentials or requests OTP/CAPTCHA/device confirmation, automatic
login opens a durable circuit and stops trying. Invalid credentials and
interactive verification remain hard blocks and do not expire automatically;
a successful manually refreshed protected report still clears the circuit as
part of the existing session verification flow, otherwise an administrator
can reset it. Ambiguous 24h submit states are temporary:
`login_in_progress`, `authentication_pending`, and `authentication_failed`
block for 15 minutes from the durable timestamp; an older state permits one
submit on the next invocation. Before that submit, an existing pending
candidate is checked with one bounded, read-only protected-report probe so a
successful earlier submit is not duplicated. There is no background timer or
automatic retry after 15 minutes—the next scheduled or manually triggered job
performs the check. Correct the server secret or complete a manual session
refresh, then an administrator can clear the circuit with
`POST /api/sessions/24h/reset-auth` using the existing admin session and CSRF
token. The automatic form keeps the public form's default customer account
type (`accountType=1`); staff account login is not enabled by these variables.
Credentials are never accepted from the browser API. This bounded recovery
does not bypass CAPTCHA, OTP, or other interactive verification.

For unattended Admicro PC or Mobile collection, configure
`SOURCE_ADMICRO_USERNAME`, `SOURCE_ADMICRO_PASSWORD`, and
`SOURCE_ADMICRO_AUTO_LOGIN=true` in the server runtime environment (or
untracked `.env`), then restart the app. The same credentials are used for
both Admicro connectors. Automatic login follows the verified HTTPS Admicro
SSO form and refuses HTTP actions or redirects. Invalid credentials,
OTP/CAPTCHA/device confirmation, missing configuration, and ambiguous submits
open a durable `admicro` auth circuit; after correcting the source secret or
finishing a manual refresh, an administrator can clear it with
`POST /api/sessions/admicro-mobile/reset-auth` using the existing admin session
and CSRF token. With `SOURCE_ADMICRO_AUTO_LOGIN=false` (the default), manual
profile sessions remain unchanged.

Automatic login fails closed unless the verified login action and its response
remain on HTTPS at `khachhang.24h.com.vn`; it blocks HTTP subresources and does
not fill or submit credentials when the action redirects to HTTP. If the
provider requires that HTTP redirect, an administrator may explicitly set
`SOURCE_24H_ALLOW_INSECURE_HTTP=true` for the 24h connector. That opt-in keeps
the verified host/path checks but permits the provider's HTTP redirect and form
submission, so enable it only on a trusted network. The default remains
`false`, and the flag does not affect Admicro. With
`SOURCE_24H_AUTO_LOGIN=false` (the default), manual session behavior keeps
using the report URL and protocol configured by the administrator; no automatic
credentials are read.

## Reports and connector limits

- A source link and date range define a report snapshot. Re-sync replaces that snapshot instead of adding totals twice. Previous snapshots remain subject to the housekeeping retention policy; editing or removing a source does not immediately erase retained snapshots.
- Daily values are read from the source when supported. `N/A` remains unknown, not zero. A result is marked reconciled only when daily totals match the period total.
- Job outcomes keep authentication (`auth_required`), invalid or interactive auto-login (`invalid_credentials`, `interactive_auth_required`), denied access (`access_denied`), unexpected response structure (`schema_error`), exhausted network/timeouts (`network_error`), and incomplete/mismatched reconciliation (`partial`) distinct. The admin job panel includes the source-facing error message and attempt/retry counts.
- Admicro PC and Mobile use the observed report tables. 24h uses its AJAX report response and existing parser. FPT/VnExpress still has no verified report reader. A stored browser profile does not by itself verify source access or report schema.
- The app never claims live source authentication from profile-file presence. Test source access with an explicit sync and review the returned reconciliation status.

## Backups and restore

Use the PostgreSQL provider's backup/restore facilities for report, account, and job data. Back up `DATA_DIR/sessions/` separately as a credential-bearing directory; keep backups encrypted and access-restricted. SQLite files from earlier versions remain untouched and are never imported or used.

## Tests

```sh
npm test
```

Auth/API tests inject in-memory stores and do not connect to the configured database or visit source websites. The comparison UI test currently fails in this checkout at its select-option polling assertion. The browser smoke script requires a disposable `DATA_DIR` and `TEST_DATABASE_URL`; configure the app under test to use that same isolated database.
