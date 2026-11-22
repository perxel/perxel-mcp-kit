-- Daily question counts per visitor ("v:<visitor id>") and per IP ("ip:<caller key>",
-- the hashed IP that rotates daily). Rows older than two days are deleted by the cron.
CREATE TABLE ask_quota (
  day TEXT NOT NULL,              -- Vietnam date, YYYY-MM-DD
  subject TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, subject)
);
