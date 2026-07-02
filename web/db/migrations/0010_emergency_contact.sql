-- Optional emergency contact details on a pilot's profile.
ALTER TABLE pilot ADD COLUMN emergency_contact_name TEXT;
ALTER TABLE pilot ADD COLUMN emergency_contact_phone TEXT;
