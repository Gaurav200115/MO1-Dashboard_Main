-- A login for the MO1 dashboard that can only read the archive (History analysis pages).
-- Run as the postgres superuser, with the password passed in (never written into this file):
--
--   psql -d marketdata -v ro_password="$RO_PW" -f readonly-role.sql
--
-- Safe to run again: it only (re)sets the password and the grants.

SELECT 'CREATE ROLE marketdata_ro LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'marketdata_ro') \gexec

ALTER ROLE marketdata_ro WITH LOGIN PASSWORD :'ro_password';
ALTER ROLE marketdata_ro SET default_transaction_read_only = on;   -- belt and braces
ALTER ROLE marketdata_ro SET statement_timeout = '30s';

GRANT CONNECT ON DATABASE marketdata TO marketdata_ro;
GRANT USAGE ON SCHEMA public TO marketdata_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO marketdata_ro;
-- tables the downloader adds later (it runs as the role "marketdata") are readable too
ALTER DEFAULT PRIVILEGES FOR ROLE marketdata IN SCHEMA public GRANT SELECT ON TABLES TO marketdata_ro;
