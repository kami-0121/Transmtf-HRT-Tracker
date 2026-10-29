/**
 * D1 schema, created and upgraded on demand by the Worker, so a fresh database
 * needs no manual migration step. MIGRATIONS[i] upgrades version i → i + 1;
 * append a new step (never edit an applied one) when the schema evolves.
 */
export const MIGRATIONS: string[][] = [
    // v1: accounts, sessions, the backup snapshot, login throttling
    [
        `CREATE TABLE IF NOT EXISTS users (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash   TEXT NOT NULL,
            password_salt   TEXT NOT NULL,
            password_iter   INTEGER NOT NULL,
            pin_salt        TEXT,
            pin_check       TEXT,
            created_at      TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS sessions (
            id              TEXT PRIMARY KEY,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            access_hash     TEXT NOT NULL UNIQUE,
            access_expires  INTEGER NOT NULL,
            refresh_hash    TEXT NOT NULL UNIQUE,
            refresh_expires INTEGER NOT NULL,
            device_info     TEXT,
            ip_address      TEXT,
            created_at      TEXT NOT NULL,
            last_used_at    TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
        `CREATE TABLE IF NOT EXISTS user_data (
            user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            payload         TEXT NOT NULL,
            is_encrypted    INTEGER NOT NULL DEFAULT 0,
            size_bytes      INTEGER NOT NULL,
            updated_at      TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS login_failures (
            username        TEXT NOT NULL COLLATE NOCASE,
            at              INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(username, at)`,
        `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    ],
    // v2: optimistic concurrency for the snapshot (a PUT names the revision it
    // was based on, so one device cannot silently overwrite another's upload)
    // and a per-user write log for rate limiting
    [
        `ALTER TABLE user_data ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
        `CREATE TABLE IF NOT EXISTS data_writes (
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            at              INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_data_writes ON data_writes(user_id, at)`,
    ],
    // v3: Google sign-in. Identities are stored as a hash of the provider's
    // subject; pending authorizations keep the PKCE verifier server-side.
    // Accounts created through Google have no login password (password_iter 0).
    [
        `CREATE TABLE IF NOT EXISTS user_identities (
            provider        TEXT NOT NULL,
            subject_hash    TEXT NOT NULL,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at      TEXT NOT NULL,
            PRIMARY KEY (provider, subject_hash),
            UNIQUE (user_id, provider)
        )`,
        `CREATE TABLE IF NOT EXISTS oauth_states (
            state_hash      TEXT PRIMARY KEY,
            verifier        TEXT NOT NULL,
            purpose         TEXT NOT NULL,
            user_id         INTEGER,
            origin          TEXT NOT NULL,
            expires         INTEGER NOT NULL
        )`,
    ],
    // v4: profile shown in the app: an editable display name (defaults to the
    // Google name), a custom avatar (small data URL) over the Google photo, and
    // whether the overview greets the user.
    [
        `ALTER TABLE users ADD COLUMN display_name TEXT`,
        `ALTER TABLE users ADD COLUMN avatar TEXT`,
        `ALTER TABLE users ADD COLUMN google_picture TEXT`,
        `ALTER TABLE users ADD COLUMN greet INTEGER NOT NULL DEFAULT 1`,
    ],
    // v5: a token refresh no longer cuts off what was just valid. The
    // previous access token keeps working until it expires, and the previous
    // refresh token for a short grace period, so requests in flight during a
    // refresh, and two tabs / the PWA refreshing at once, do not fail.
    [
        `ALTER TABLE sessions ADD COLUMN prev_access_hash TEXT`,
        `ALTER TABLE sessions ADD COLUMN prev_access_expires INTEGER`,
        `ALTER TABLE sessions ADD COLUMN prev_refresh_hash TEXT`,
        `ALTER TABLE sessions ADD COLUMN prev_refresh_until INTEGER`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_prev_access ON sessions(prev_access_hash)`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_prev_refresh ON sessions(prev_refresh_hash)`,
    ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

const readVersion = (db: D1Database) =>
    db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>()
        .then(row => Number(row?.value ?? 0))
        .catch(() => 0);   // no schema_meta yet: empty database

async function migrate(db: D1Database): Promise<void> {
    for (let v = await readVersion(db); v < SCHEMA_VERSION; v++) {
        try {
            await db.batch([
                ...MIGRATIONS[v].map(sql => db.prepare(sql)),
                db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)`).bind(String(v + 1)),
            ]);
        } catch (e) {
            // Another isolate may have applied the same step concurrently
            // (ALTER TABLE is not idempotent); that is fine if it got there.
            if (await readVersion(db) <= v) throw e;
        }
    }
}

let ensured: Promise<void> | null = null;

/** Create / upgrade the schema once per isolate (cheap no-op afterwards). */
export function ensureSchema(db: D1Database): Promise<void> {
    if (!ensured) {
        ensured = migrate(db).catch((e) => { ensured = null; throw e; });
    }
    return ensured;
}
