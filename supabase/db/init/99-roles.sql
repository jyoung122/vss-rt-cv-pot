-- Set passwords for supabase internal users. Runs ONLY on fresh cluster init
-- (Postgres docker-entrypoint-initdb.d semantics) — before the supautils trigger
-- locks down the reserved roles.
\set pgpass `echo "$POSTGRES_PASSWORD"`
ALTER USER supabase_admin             WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin        WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin     WITH PASSWORD :'pgpass';
ALTER USER authenticator              WITH PASSWORD :'pgpass';
ALTER USER supabase_replication_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_read_only_user    WITH PASSWORD :'pgpass';
