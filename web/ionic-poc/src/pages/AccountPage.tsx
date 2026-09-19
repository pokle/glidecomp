import {
  IonAvatar,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonTitle,
  IonToggle,
  IonToolbar,
} from "@ionic/react";
import {
  colorPaletteOutline,
  gridOutline,
  logInOutline,
  logOutOutline,
  settingsOutline,
} from "ionicons/icons";
import { usePrefs } from "@/state/prefs";

const AccountPage: React.FC = () => {
  const { role, setRole, signedIn, setSignedIn, mode } = usePrefs();

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonTitle>Me</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonHeader collapse="condense">
          <IonToolbar>
            <IonTitle size="large">Me</IonTitle>
          </IonToolbar>
        </IonHeader>

        <IonList inset>
          <IonItem>
            <IonAvatar slot="start">
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  borderRadius: "50%",
                  background: "var(--gc-primary)",
                  color: "#fff",
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 700,
                }}
              >
                JD
              </div>
            </IonAvatar>
            <IonLabel>
              <h2>{signedIn ? "Jon Durand" : "Signed out"}</h2>
              <p>{signedIn ? "jon@example.com" : "Browse as a visitor"}</p>
            </IonLabel>
          </IonItem>
        </IonList>

        <IonList inset>
          <IonItem>
            <IonToggle
              justify="space-between"
              checked={role === "organiser"}
              onIonChange={(e) => setRole(e.detail.checked ? "organiser" : "pilot")}
            >
              Organiser controls
            </IonToggle>
          </IonItem>
          <IonItem routerLink="/tabs/me/settings" detail>
            <IonIcon icon={settingsOutline} slot="start" />
            <IonLabel>Settings</IonLabel>
          </IonItem>
          <IonItem routerLink="/tabs/me/kit" detail>
            <IonIcon icon={gridOutline} slot="start" />
            <IonLabel>Component gallery</IonLabel>
            <IonNote slot="end">Ionic kit</IonNote>
          </IonItem>
          <IonItem>
            <IonIcon icon={colorPaletteOutline} slot="start" />
            <IonLabel>
              <h2>Look</h2>
              <p>
                {mode === "ios" ? "iOS" : "Material"} · change it from the bar above
                the phone
              </p>
            </IonLabel>
          </IonItem>
        </IonList>

        <IonList inset>
          {signedIn ? (
            <IonItem button onClick={() => setSignedIn(false)}>
              <IonIcon icon={logOutOutline} slot="start" color="danger" />
              <IonLabel color="danger">Sign out</IonLabel>
            </IonItem>
          ) : (
            <IonItem routerLink="/signin">
              <IonIcon icon={logInOutline} slot="start" />
              <IonLabel>Sign in</IonLabel>
            </IonItem>
          )}
        </IonList>
        <p className="muted" style={{ padding: "8px 20px 28px" }}>
          This tab is the user menu the desktop header currently hides behind an
          avatar. On a phone it is a first-class place.
        </p>
      </IonContent>
    </IonPage>
  );
};

export default AccountPage;
