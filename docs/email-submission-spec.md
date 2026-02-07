# Email Submission Specification

## Overview

Pilots submit track logs (IGC files) by emailing them to `submit@{domain}`. This specification defines the email processing workflow, security measures, and low-friction validation approach.

## Design Philosophy

**Low Friction, Flag Don't Reject**

- Accept all valid IGC files, even from suspicious sources
- Flag potential security issues for admin investigation
- Never block legitimate pilots due to email configuration issues
- Appropriate for low-stakes competitions (no prize money)

## Email Processing Workflow

### 1. Receive Email

Email Worker receives message at `submit@{domain}`.

### 2. Archive Raw Email

**Always archive first, before any processing or validation.**

```
Store to: /emails/{timestamp}-{sha256}.eml
```

- Timestamp: ISO 8601 format (UTC)
- SHA256: Hash of raw email content (for deduplication)
- Ensures audit trail even if processing fails
- Admin-only access to email archives

### 3. Email Authentication Check

**Check SPF/DKIM/DMARC but FLAG failures, don't reject.**

Cloudflare Email Workers provide authentication results in message headers:
- `Received-SPF` header - SPF check result
- `Authentication-Results` header - DKIM and DMARC results

**Authentication Status:**
- ✅ **PASS** - Email passes SPF, DKIM, or DMARC
- ⚠️ **FAIL** - Email fails all authentication checks
- ❓ **NEUTRAL** - No authentication configured for sender domain

**Action on Failure:**
- Continue processing (do NOT reject)
- Set `auth_suspicious` flag on submission record
- Admin can review flagged submissions later

**Rationale:**
- Some legitimate email providers have poor SPF/DKIM setup
- Small flying clubs may use shared email services
- Manual review is acceptable for low-stakes competitions

### 4. Extract and Parse

- Extract sender email from `From:` header
- Parse MIME attachments using `postal-mime`
- Find `.igc` files (by extension or content type)

### 5. Validate IGC File

- Check IGC file format (starts with `A` record, has `B` records)
- Compute SHA-256 hash of file content

**On Invalid IGC:**
- Forward email to admin inbox
- Archive stored for manual review
- Send friendly error response to pilot

### 6. Store IGC File

Content-addressed storage in R2:

```
/igc/{sha256}.igc
```

- Check if file already exists (deduplication)
- Store if new, skip if duplicate
- Record in `igc_files` table

### 7. Sender Lookup

Look up sender email in `pilot_emails` table:

```sql
SELECT pilot_id FROM pilot_emails WHERE email = ?
```

**Result:**
- ✅ **Found** - Email is authorized, link to pilot
- ❌ **Not Found** - Email not in system, create unmatched submission

### 8. Create Submission Record

Insert into `submissions` table with fields:

```sql
INSERT INTO submissions (
  sender_email,
  igc_hash,
  pilot_id,              -- NULL if sender not found
  competition_id,        -- NULL if pilot not in active competition
  status,                -- 'unmatched', 'matched', or 'entered'
  auth_suspicious,       -- TRUE if SPF/DKIM/DMARC failed
  email_archive_path,
  received_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```

**Status Values:**
- `unmatched` - Sender email not recognized
- `matched` - Sender linked to pilot, but not in competition
- `entered` - Linked to pilot AND active competition

**Security Flag:**
- `auth_suspicious = TRUE` if email failed authentication checks
- Admin can filter/review flagged submissions

### 9. Send Confirmation Email

**Always send confirmation to pilot** - creates audit trail and allows pilots to detect spoofing.

**Confirmation Content:**

```
Subject: Track log received - {filename}

Hi,

Your track log has been received and stored:
- File: {original_filename}
- Date: {flight_date from IGC}
- Received: {timestamp}
- Status: {status_message}

{status_specific_message}

If you did NOT submit this flight, please contact the competition admin immediately.

Submission ID: {submission_id}
```

**Status-Specific Messages:**

- **Entered:** "Your flight has been entered in {competition_name}. This is submission #{count} for this competition."
- **Matched:** "Your flight has been stored and linked to your pilot profile. It will be available when you enter a competition."
- **Unmatched:** "Your flight has been stored, but your email address is not yet registered. Contact the competition admin to link your flights to your pilot profile."

**Security Note:**
If `auth_suspicious = TRUE`, do NOT mention this to the pilot (to avoid confusion). Admin will review flagged submissions separately.

### 10. Admin Notifications

**Forward to admin inbox when:**
- Invalid IGC file attachment
- Processing errors or exceptions
- Unmatched sender (optional, based on competition settings)

**Do NOT forward for:**
- Failed email authentication (use flag instead)
- Duplicate submissions (normal behavior)
- Matched but not entered (pilot not in competition)

## Email Authentication Details

### SPF (Sender Policy Framework)

Validates the sending mail server is authorized by the domain owner.

**Header:** `Received-SPF`
**Values:** `Pass`, `Fail`, `SoftFail`, `Neutral`, `None`

### DKIM (DomainKeys Identified Mail)

Cryptographic signature that verifies email hasn't been tampered with.

**Header:** `Authentication-Results`
**Values:** `pass`, `fail`, `neutral`, `none`

### DMARC (Domain-based Message Authentication)

Policy that specifies how to handle emails that fail SPF/DKIM.

**Header:** `Authentication-Results`
**Values:** `pass`, `fail`, `none`

### Implementation Example

```typescript
function checkEmailAuthentication(message: EmailMessage): {
  passed: boolean;
  suspicious: boolean;
  details: string;
} {
  const spf = message.headers.get('received-spf') || '';
  const authResults = message.headers.get('authentication-results') || '';

  // Check if any authentication passed
  const spfPass = spf.toLowerCase().includes('pass');
  const dkimPass = authResults.toLowerCase().includes('dkim=pass');
  const dmarcPass = authResults.toLowerCase().includes('dmarc=pass');

  const passed = spfPass || dkimPass || dmarcPass;

  // Mark as suspicious if ALL checks failed/absent
  const suspicious = !passed;

  return {
    passed,
    suspicious,
    details: `SPF: ${spf}, Auth: ${authResults}`
  };
}
```

## Database Schema Changes

### submissions table

Add `auth_suspicious` column:

```sql
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY,
  sender_email TEXT NOT NULL,
  igc_hash TEXT NOT NULL,
  pilot_id INTEGER,
  competition_id INTEGER,
  status TEXT NOT NULL,  -- 'unmatched', 'matched', 'entered'
  auth_suspicious BOOLEAN DEFAULT FALSE,  -- NEW: Email auth failed
  email_archive_path TEXT NOT NULL,
  received_at DATETIME NOT NULL,

  FOREIGN KEY (pilot_id) REFERENCES pilots(id),
  FOREIGN KEY (competition_id) REFERENCES competitions(id),
  FOREIGN KEY (igc_hash) REFERENCES igc_files(hash)
);

CREATE INDEX idx_submissions_suspicious ON submissions(auth_suspicious);
CREATE INDEX idx_submissions_status ON submissions(status);
```

## Admin Interface

### Flagged Submissions View

Admin dashboard should show:

```
⚠️ Flagged Submissions (Suspicious Email Authentication)

| Pilot | Competition | File | Received | Sender Email | Actions |
|-------|-------------|------|----------|--------------|---------|
| Unknown | Spring Cup | 2024-05-10.igc | 2024-05-11 | spoofed@example.com | [View Details] [Accept] [Reject] |
```

**Actions:**
- **View Details** - Show email headers, authentication results, raw email archive
- **Accept** - Clear `auth_suspicious` flag, mark submission as valid
- **Reject** - Delete submission, notify sender

### Filter Options

- Show only flagged submissions
- Show unmatched submissions
- Show all submissions

## Security Considerations

### What This Protects Against

✅ **Casual spoofing** - Random person forging pilot email
✅ **Gmail/Outlook spoofing** - Major providers with good SPF/DKIM
✅ **Pilot notification** - Confirmation emails let pilots catch unauthorized submissions
✅ **Admin oversight** - Flagged submissions for manual review

### What This Does NOT Protect Against

❌ **Compromised email accounts** - If pilot's actual email is hacked
❌ **Forwarded emails** - Email forwarding often breaks DKIM
❌ **Mailing lists** - List servers may alter headers
❌ **Small provider spoofing** - Providers without SPF/DKIM setup

### Acceptable Risk

For low-stakes competitions with no prize money:
- False positives (flagging legitimate emails) are worse than false negatives
- Manual admin review is acceptable trade-off
- Pilot notification creates social accountability
- Email archival provides forensic evidence if needed

## Testing Checklist

- [ ] SPF pass → submission accepted, not flagged
- [ ] SPF fail → submission accepted, flagged as suspicious
- [ ] DKIM pass → submission accepted, not flagged
- [ ] DKIM fail → submission accepted, flagged as suspicious
- [ ] All auth fail → submission accepted, flagged as suspicious
- [ ] No auth headers → submission accepted, not flagged (benefit of doubt)
- [ ] Confirmation email sent to pilot with correct status
- [ ] Admin can view flagged submissions
- [ ] Admin can clear flags on legitimate submissions
- [ ] Email archive includes full headers for forensic review

## Future Enhancements

**If competition stakes increase:**

1. **Competition-specific tokens** - Email pilots a unique token at competition start
2. **IP geolocation** - Flag submissions from unexpected countries
3. **Rate limiting** - Limit submissions per email address per day
4. **Two-factor confirmation** - Require pilot to confirm via web link for flagged submissions

**Not recommended for current use case** - adds friction without proportional security benefit.
