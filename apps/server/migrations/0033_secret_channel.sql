-- NULL is reserved for non-channel provider credentials and pre-activation rows.
ALTER TABLE escalator_secret ADD COLUMN channel text
  CHECK (channel IN ('pushover', 'webhook', 'ntfy', 'slack', 'discord', 'email'));
