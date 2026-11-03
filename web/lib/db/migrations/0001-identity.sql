CREATE TABLE meta (
  key        TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9_]*'),
  value      TEXT    NOT NULL CHECK (length(value) <= 512),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE users (
  id                   TEXT    PRIMARY KEY CHECK (length(id) = 36),
  username             TEXT    NOT NULL COLLATE NOCASE
                       CHECK (length(username) BETWEEN 3 AND 32
                              AND username = lower(username)
                              AND username NOT GLOB '*[^a-z0-9._-]*'),
  display_name         TEXT    NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  role                 TEXT    NOT NULL CHECK (role IN ('admin','member')),
  status               TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  password_hash        TEXT    NOT NULL CHECK (password_hash GLOB 'scrypt$*'),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  is_bootstrap         INTEGER NOT NULL DEFAULT 0 CHECK (is_bootstrap IN (0,1)),
  is_smoke             INTEGER NOT NULL DEFAULT 0 CHECK (is_smoke IN (0,1)),
  locale               TEXT    NULL CHECK (locale IS NULL OR (length(locale) BETWEEN 2 AND 16 AND locale GLOB '[a-z]*')),  -- 07 §9.4
  -- NULL = pakai default instans (instance_settings member_*); admin tidak dibatasi
  storage_quota_bytes  INTEGER NULL CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes >= 0),
  max_active_jobs      INTEGER NULL CHECK (max_active_jobs   IS NULL OR max_active_jobs   >= 0),
  max_running_jobs     INTEGER NULL CHECK (max_running_jobs  IS NULL OR max_running_jobs  >= 0),
  jobs_per_hour        INTEGER NULL CHECK (jobs_per_hour     IS NULL OR jobs_per_hour     >= 0),
  max_source_seconds   INTEGER NULL CHECK (max_source_seconds IS NULL OR max_source_seconds > 0),
  llm_share            INTEGER NULL CHECK (llm_share IS NULL OR llm_share IN (0,1)),  -- NULL = ikut instans
  trends_enabled       INTEGER NOT NULL DEFAULT 1 CHECK (trends_enabled IN (0,1)),
  password_changed_at  INTEGER NOT NULL,
  last_login_at        INTEGER NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  disabled_at          INTEGER NULL,
  created_by           TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  CHECK (NOT (is_smoke = 1 AND role = 'admin')),
  CHECK (NOT (is_bootstrap = 1 AND is_smoke = 1))
) STRICT;
CREATE UNIQUE INDEX users_username       ON users(username);
CREATE UNIQUE INDEX users_one_bootstrap  ON users(is_bootstrap) WHERE is_bootstrap = 1;
CREATE UNIQUE INDEX users_one_smoke      ON users(is_smoke)     WHERE is_smoke = 1;
CREATE INDEX        users_role_status    ON users(role, status);

CREATE TABLE sessions (
  id               TEXT    PRIMARY KEY CHECK (length(id) = 22),           -- sid, 16 byte base64url
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_sha256    TEXT    NOT NULL CHECK (length(secret_sha256) = 64),
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,                                      -- created_at + 30 hari, absolut
  last_seen_at     INTEGER NOT NULL,                                      -- ditulis ≤ 1×/menit
  reauth_at        INTEGER NULL,                                          -- re-auth terakhir (aksi admin)
  revoked_at       INTEGER NULL,
  revoke_reason    TEXT    NULL CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 32),
  -- logout|logout_all|password_changed|disabled|admin_revoked|limit|deleted (JS, 02 §4.2)
  device_label     TEXT    NULL CHECK (device_label IS NULL OR length(device_label) <= 120),  -- dari User-Agent
  via              TEXT    NOT NULL CHECK (via IN ('password','break_glass','upgrade_v1','invite','reset')),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
) STRICT;
CREATE INDEX sessions_user_live ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires   ON sessions(expires_at);

CREATE TABLE invites (
  id            TEXT    PRIMARY KEY CHECK (length(id) = 36),
  token_sha256  TEXT    NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  token_prefix  TEXT    NOT NULL CHECK (length(token_prefix) = 10),        -- "piv_" + 6, untuk tampilan
  role          TEXT    NOT NULL CHECK (role IN ('admin','member')),
  locale        TEXT    NOT NULL CHECK (length(locale) BETWEEN 2 AND 16),  -- bahasa undangan (Q9)
  username_hint TEXT    NULL CHECK (username_hint IS NULL OR length(username_hint) <= 32),
  note          TEXT    NULL CHECK (note IS NULL OR length(note) <= 80),
  created_by    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER NULL,
  used_by       TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,
  revoked_at    INTEGER NULL,
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
) STRICT;
CREATE INDEX invites_open    ON invites(expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invites_creator ON invites(created_by, created_at);

CREATE TABLE password_resets (
  id           TEXT    PRIMARY KEY CHECK (length(id) = 36),
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_sha256 TEXT    NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  created_by   TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,       -- NULL = permintaan sendiri (SMTP)
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER NULL,
  revoked_at   INTEGER NULL,
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
) STRICT;
CREATE INDEX password_resets_user_open ON password_resets(user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX password_resets_expires   ON password_resets(expires_at);

CREATE TABLE api_tokens (
  id            TEXT    PRIMARY KEY CHECK (length(id) = 36),             -- impor memakai id dari file
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  prefix        TEXT    NOT NULL CHECK (length(prefix) = 10 AND prefix GLOB 'ptk_*'),
  sha256        TEXT    NOT NULL UNIQUE CHECK (length(sha256) = 64),
  scopes        TEXT    NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'
                                        AND json_array_length(scopes) BETWEEN 1 AND 8),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NULL,                                              -- ditulis ≤ 1×/menit
  revoked_at    INTEGER NULL,
  imported_from TEXT    NULL CHECK (imported_from IS NULL OR imported_from = 'ingest-tokens.json')
) STRICT;
CREATE INDEX api_tokens_user_live ON api_tokens(user_id) WHERE revoked_at IS NULL;

CREATE TABLE instance_settings (
  key        TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9_]*'),
  value_json TEXT    NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 4096),
  updated_at INTEGER NOT NULL,
  updated_by TEXT    NULL REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  code           TEXT    NOT NULL CHECK (length(code) BETWEEN 3 AND 64 AND code GLOB '[a-z]*.[a-z]*'),
  actor_kind     TEXT    NOT NULL CHECK (actor_kind IN ('user','token','system','cli')),
  actor_user_id  TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_label    TEXT    NULL CHECK (actor_label IS NULL OR length(actor_label) <= 32),   -- snapshot username
  target_user_id TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,
  target_label   TEXT    NULL CHECK (target_label IS NULL OR length(target_label) <= 32),
  job_id         TEXT    NULL CHECK (job_id IS NULL OR length(job_id) = 36),
  params_json    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(params_json) AND json_type(params_json) = 'object'
                                                      AND length(params_json) <= 2048),
  request_id     TEXT    NULL CHECK (request_id IS NULL OR length(request_id) <= 64)
) STRICT;
CREATE INDEX audit_at     ON audit_events(at);
CREATE INDEX audit_actor  ON audit_events(actor_user_id, at);
CREATE INDEX audit_target ON audit_events(target_user_id, at);
CREATE INDEX audit_job    ON audit_events(job_id) WHERE job_id IS NOT NULL;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OF at, code, actor_kind, actor_label, target_label, job_id, params_json, request_id
  ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

-- Detak proses pembuka DB (§2.2 aturan 6). Satu baris per (role, host); host = os.hostname()
-- (id container). Satu-satunya tabel detak (tidak ada tabel detak khusus sosmed).
CREATE TABLE process_heartbeats (
  role       TEXT    NOT NULL CHECK (role IN ('app','primary','social')),
  host       TEXT    NOT NULL CHECK (length(host) BETWEEN 1 AND 64),
  pid        INTEGER NOT NULL CHECK (pid > 0),
  image_sha  TEXT    NULL CHECK (image_sha IS NULL OR length(image_sha) <= 64),   -- POTONGIN_APP_COMMIT
  started_at INTEGER NOT NULL,
  beat_at    INTEGER NOT NULL,
  PRIMARY KEY (role, host)
) STRICT, WITHOUT ROWID;

INSERT OR IGNORE INTO instance_settings(key, value_json, updated_at) VALUES
  ('signup_mode',                '"invite"',   0),
  ('llm_share',                  'true',       0),
  ('llm_daily_cap',              '200',        0),
  ('groq_share',                 'false',      0),
  ('youtube_cookies_share',      'true',       0),
  ('member_llm_keys_allowed',    'true',       0),
  ('trends_scope',               '"instance"', 0),
  ('member_storage_quota_bytes', 'null',       0),
  ('member_max_active_jobs',     '3',          0),
  ('member_max_running_jobs',    '1',          0),
  ('member_jobs_per_hour',       '30',         0),
  ('member_max_source_seconds',  '14400',      0),
  ('invite_ttl_hours',           '168',        0),
  ('reset_ttl_hours',            '24',         0);
