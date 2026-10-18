-- Global schema metadata, not a second tenant identifier.
CREATE TABLE escalator_compatibility (
 id integer PRIMARY KEY CHECK (id=1),
 schema_version integer NOT NULL CHECK (schema_version>=1),
 minimum_contract_version integer NOT NULL CHECK (minimum_contract_version>=1),
 maximum_contract_version integer NOT NULL CHECK (maximum_contract_version>=minimum_contract_version)
);
INSERT INTO escalator_compatibility (id,schema_version,minimum_contract_version,maximum_contract_version) VALUES (1,1,1,1);
-- Runtime roles receive SELECT and UPDATE(id) only for transaction-scoped row locks.
-- The singleton check prevents changing the id; version fields remain operator-owned.
