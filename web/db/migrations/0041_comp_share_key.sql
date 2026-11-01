-- ── comp.share_key ─────────────────────────────────────────────────────────
--
-- The secret half of a hidden competition's link. A hidden (`test`) comp
-- answers as missing to everyone except its admins AND anyone whose URL
-- carries this key after the comp's id: `/comp/corryong-cup-2027-vzuq_7hq2m9xk4rwd`.
-- The comp id itself is a sequential number in a public encoding, so it is
-- no secret; this is. See `web/workers/competition-api/src/share-key.ts`.
--
-- Twelve characters of [a-z0-9] (about 62 bits): every guess costs a request,
-- so that is out of reach of online guessing. "Reset link" writes a new one,
-- which retires every link shared so far.
--
-- Every comp has a key, public ones included, so hiding a comp never has to
-- mint one first. Only a hidden comp ever needs it.
ALTER TABLE comp ADD COLUMN share_key TEXT;

-- One random character of the key's alphabet. `random() % 36` lies in
-- (-36, 36), so abs() of it can never overflow, and the modulo bias over a
-- 64-bit source is negligible.
UPDATE comp SET share_key =
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1)
WHERE share_key IS NULL;

-- The comp routes name a key on every INSERT (newShareKey()), but comps are
-- also written by the sample seeder, the AirScore importer and the tests. The
-- trigger means none of them can leave a comp without a key, rather than each
-- having to remember.
CREATE TRIGGER IF NOT EXISTS comp_share_key_default
AFTER INSERT ON comp
WHEN NEW.share_key IS NULL
BEGIN
  UPDATE comp SET share_key =
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1) ||
    substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + abs(random() % 36), 1)
  WHERE comp_id = NEW.comp_id;
END;
