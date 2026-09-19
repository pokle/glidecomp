import { useState } from "react";
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  useIonAlert,
  useIonToast,
} from "@ionic/react";
import { BackLink } from "@/components/ui";
import { usePrefs, type ThemePref, type Units } from "@/state/prefs";

const SettingsPage: React.FC = () => {
  const { theme, setTheme, units, setUnit } = usePrefs();
  const [toast] = useIonToast();
  const [alert] = useIonAlert();
  const [saved, setSaved] = useState("");

  function flash() {
    setSaved("Saved");
    window.setTimeout(() => setSaved(""), 1600);
  }

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <BackLink href="/tabs/me">Me</BackLink>
          <IonTitle>Settings</IonTitle>
          <IonButtons slot="end">
            <IonNote>{saved}</IonNote>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <p className="section-label">Profile</p>
        <IonList inset>
          <IonItem>
            <IonInput label="Full name" value="Jon Durand" />
          </IonItem>
          <IonItem>
            <IonInput label="Username" value="durand" />
          </IonItem>
        </IonList>

        <p className="section-label">Appearance</p>
        <IonList inset>
          <IonItem>
            <IonSelect
              label="Theme"
              interface="action-sheet"
              value={theme}
              onIonChange={(e) => {
                setTheme(e.detail.value as ThemePref);
                flash();
              }}
            >
              <IonSelectOption value="light">Light — always</IonSelectOption>
              <IonSelectOption value="dark">Dark — always</IonSelectOption>
              <IonSelectOption value="auto">Auto — follow the device</IonSelectOption>
            </IonSelect>
          </IonItem>
        </IonList>

        <p className="section-label">Units</p>
        <IonList inset>
          {(
            [
              ["speed", "Speed", ["km/h", "mph", "knots"]],
              ["altitude", "Altitude", ["m", "ft"]],
              ["climbRate", "Climb", ["m/s", "ft/min", "knots"]],
              ["distance", "Distance", ["km", "mi", "nmi"]],
            ] as const
          ).map(([key, label, options]) => (
            <IonItem key={key}>
              <IonSelect
                label={label}
                interface="action-sheet"
                value={units[key]}
                onIonChange={(e) => {
                  setUnit(key, e.detail.value as Units[typeof key]);
                  flash();
                }}
              >
                {options.map((opt) => (
                  <IonSelectOption key={opt} value={opt}>
                    {opt === "nmi" ? "NM" : opt}
                  </IonSelectOption>
                ))}
              </IonSelect>
            </IonItem>
          ))}
        </IonList>
        <p className="muted" style={{ padding: "0 20px" }}>
          An altitude a reader types is in the reader’s own unit, and the label
          says which. Cylinder radii stay in metres.
        </p>

        <p className="section-label">API keys</p>
        <IonList inset>
          <IonItem>
            <IonLabel>
              <h2>CLI</h2>
              <p>Created 12 Aug 2026 · last used 2h ago</p>
            </IonLabel>
            <IonButton
              slot="end"
              fill="clear"
              color="danger"
              onClick={() =>
                void alert({
                  header: "Revoke this key?",
                  message: "Scripts using it will stop working immediately.",
                  buttons: [
                    { text: "Cancel", role: "cancel" },
                    {
                      text: "Revoke",
                      role: "destructive",
                      handler: () => void toast({ message: "Key revoked (mocked).", duration: 1400 }),
                    },
                  ],
                })
              }
            >
              Revoke
            </IonButton>
          </IonItem>
        </IonList>
        <div className="ion-padding">
          <IonButton
            expand="block"
            fill="outline"
            onClick={() => void toast({ message: "New key would be shown once.", duration: 1600 })}
          >
            Create API key
          </IonButton>
        </div>

        <p className="section-label">Danger zone</p>
        <div className="ion-padding" style={{ paddingTop: 0 }}>
          <IonButton
            expand="block"
            color="danger"
            onClick={() =>
              void alert({
                header: "Delete account?",
                message: "This cannot be undone. Competition uploads you made as a pilot stay on those comps.",
                buttons: [
                  { text: "Cancel", role: "cancel" },
                  { text: "Delete account", role: "destructive" },
                ],
              })
            }
          >
            Delete account
          </IonButton>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default SettingsPage;
