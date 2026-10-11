// The local auth worker records the last sign-in code it "sent" (dev only:
// GET /api/auth/dev-last-otp), so a flow can sign in without a mailbox.
const res = http.get(`${API}/api/auth/dev-last-otp?email=${encodeURIComponent(EMAIL)}`);
output.otp = json(res.body).otp;
