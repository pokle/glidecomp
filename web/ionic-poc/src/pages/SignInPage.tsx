import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonInputOtp,
  IonItem,
  IonList,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
  useIonToast,
} from "@ionic/react";
import { usePrefs } from "@/state/prefs";

const SignInPage: React.FC = () => {
  const navigate = useNavigate();
  const { setSignedIn } = usePrefs();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast] = useIonToast();

  async function verify(code: string) {
    setBusy(true);
    await new Promise((r) => setTimeout(r, 600));
    setBusy(false);
    if (code !== "123456") {
      void toast({
        message: "That code is wrong. Try 123456 in this POC.",
        color: "danger",
        duration: 2200,
      });
      return;
    }
    setSignedIn(true);
    navigate("/tabs/comps", { replace: true });
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Sign in</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>GlideComp</h1>
        {step === "email" ? (
          <>
            <p className="muted">We’ll email you a six-digit code. No password.</p>
            <IonList inset>
              <IonItem>
                <IonInput
                  type="email"
                  label="Email"
                  value={email}
                  onIonInput={(e) => setEmail(e.detail.value ?? "")}
                  placeholder="you@example.com"
                />
              </IonItem>
            </IonList>
            <IonButton
              expand="block"
              disabled={!email.includes("@")}
              onClick={() => {
                setStep("code");
                void toast({ message: `Code sent to ${email} (mocked).`, duration: 1800 });
              }}
            >
              Email me a code
            </IonButton>
            <IonButton
              expand="block"
              fill="outline"
              onClick={() => {
                setSignedIn(true);
                navigate("/tabs/comps", { replace: true });
              }}
            >
              Continue with Google
            </IonButton>
          </>
        ) : (
          <>
            <p className="muted">Enter the code we sent to {email}.</p>
            <div style={{ padding: "8px 0 16px" }}>
              <IonInputOtp
                length={6}
                type="number"
                inputmode="numeric"
                size="large"
                onIonComplete={(e) => {
                  const code = e.detail.value;
                  if (code) void verify(code);
                }}
              />
            </div>
            {busy ? <IonSpinner name="crescent" /> : null}
            <IonButton expand="block" fill="clear" onClick={() => setStep("email")}>
              Use a different email
            </IonButton>
            <p className="muted">POC shortcut: 123456</p>
          </>
        )}
      </IonContent>
    </IonPage>
  );
};

export default SignInPage;
