/**
 * D1 schema, created on demand by the Worker (idempotent `IF NOT EXISTS`), so
 * a fresh database needs no manual migration step. Bump SCHEMA_VERSION and
 * append statements (never edit old ones) when the schema evolves.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_STATEMENTS: string[] = [
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
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '${SCHEMA_VERSION}')`,
];

let ensured: Promise<void> | null = null;

/** Create the schema once per isolate (cheap no-op afterwards). */
export function ensureSchema(db: D1Database): Promise<void> {
    if (!ensured) {
        ensured = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>()
            .catch(() => null)
            .then(async (row) => {
                if (row && Number(row.value) >= SCHEMA_VERSION) return;
                await db.batch(SCHEMA_STATEMENTS.map(sql => db.prepare(sql)));
            })
            .catch((e) => { ensured = null; throw e; });
    }
    return ensured;
}
