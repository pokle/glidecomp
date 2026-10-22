/**
 * The Android App Links association (mobile plan stage 9): the packages that
 * may open glidecomp.com links, and the certificates they are signed with,
 * from the Pages project's `ANDROID_CERT_SHA256` variable (comma-separated
 * SHA-256 fingerprints: Play's app-signing key, and a debug keystore's for a
 * development build). Not secrets — they are public by design — but not
 * known until the Play account exists. A 404 until it is set.
 */
import { androidAssetLinks } from "../../web/client/src/app-links";

interface Env {
  ANDROID_CERT_SHA256?: string;
}

export const onRequestGet: PagesFunction<Env> = ({ env }) => {
  const doc = androidAssetLinks(env.ANDROID_CERT_SHA256);
  if (!doc) return new Response("Not configured", { status: 404 });
  return new Response(JSON.stringify(doc), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
};
