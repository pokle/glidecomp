/**
 * /signin/app — the app's sign-in link, opened somewhere the app isn't (mobile
 * plan stage 9). On a phone with the app, iOS and Android hand this URL to
 * the app instead (web/client/src/app-links.ts), so a reader only lands here
 * on a desktop, or on a phone without the app. It is NOT the website's sign-in:
 * the code was asked for by the app, so it says to type the code there.
 *
 * The code rides in the fragment, which never reaches a server; the page
 * reads it, shows it, and strips it from the address bar.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/react/rac/card";

export function SignInAppLink() {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    document.title = "GlideComp - Sign in to the app";
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const otp = params.get("otp");
    if (otp && /^\d{4,8}$/.test(otp)) setCode(otp);
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  return (
    <div className="mx-auto mt-8 max-w-md">
      <Card className="gap-3">
        <h1 className="text-xl font-bold">Sign in to the GlideComp app</h1>
        <p>
          This link signs you in to the GlideComp app. Open it on the phone where you asked for
          the code, or type the code into the app.
        </p>
        {code ? (
          <p className="font-mono text-3xl font-bold tracking-[0.3em]" aria-label={`Code ${code.split("").join(" ")}`}>
            {code}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Signing in to the website instead?{" "}
          <Link to="/signin" className="underline underline-offset-4">
            Email yourself a code from the website
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
