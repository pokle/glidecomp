import { useState } from "react";
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonProgressBar,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
  useIonAlert,
  useIonToast,
} from "@ionic/react";
import { documentOutline, folderOpenOutline, trashOutline } from "ionicons/icons";
import { FLIGHTS } from "@/data/mock";
import { usePrefs } from "@/state/prefs";

const FlightsPage: React.FC = () => {
  const { signedIn, formatDistance } = usePrefs();
  const [tab, setTab] = useState<"tracks" | "tasks">("tracks");
  const [flights, setFlights] = useState(FLIGHTS);
  const [alert] = useIonAlert();
  const [toast] = useIonToast();

  if (!signedIn) {
    return (
      <IonPage>
        <IonHeader>
          <IonToolbar>
            <IonTitle>My Flights</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding">
          <p>Sign in to keep a private library of IGC files and tasks on this device.</p>
          <IonButton expand="block" routerLink="/signin">
            Sign in
          </IonButton>
        </IonContent>
      </IonPage>
    );
  }

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonTitle>My Flights</IonTitle>
          <IonButtons slot="end">
            <IonButton
              onClick={() => void toast({ message: "File picker would open.", duration: 1200 })}
            >
              Import
            </IonButton>
          </IonButtons>
        </IonToolbar>
        <IonToolbar>
          <IonSegment
            value={tab}
            onIonChange={(e) => setTab((e.detail.value as typeof tab) || "tracks")}
          >
            <IonSegmentButton value="tracks">Tracks</IonSegmentButton>
            <IonSegmentButton value="tasks">Tasks</IonSegmentButton>
          </IonSegment>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <div className="ion-padding">
          <p className="muted" style={{ margin: "0 0 6px" }}>
            Library storage · 42 MB of 200 MB
          </p>
          <IonProgressBar value={0.21} />
        </div>

        {tab === "tracks" ? (
          <IonList inset>
            {flights.map((f) => (
              <IonItemSliding key={f.id}>
                <IonItem button onClick={() => void toast({ message: "Analysis would open.", duration: 1200 })}>
                  <IonIcon icon={documentOutline} slot="start" />
                  <IonLabel>
                    <h2>{f.name}</h2>
                    <p>
                      {f.date} · {f.duration}
                    </p>
                  </IonLabel>
                  <IonNote slot="end" className="tabular">
                    {formatDistance(f.km)}
                  </IonNote>
                </IonItem>
                <IonItemOptions side="end">
                  <IonItemOption
                    color="danger"
                    onClick={() =>
                      void alert({
                        header: "Delete this track?",
                        message: "It leaves this device. Competition uploads are untouched.",
                        buttons: [
                          { text: "Cancel", role: "cancel" },
                          {
                            text: "Delete",
                            role: "destructive",
                            handler: () => setFlights((prev) => prev.filter((x) => x.id !== f.id)),
                          },
                        ],
                      })
                    }
                  >
                    <IonIcon slot="icon-only" icon={trashOutline} />
                  </IonItemOption>
                </IonItemOptions>
              </IonItemSliding>
            ))}
          </IonList>
        ) : (
          <IonList inset>
            <IonItem>
              <IonIcon icon={folderOpenOutline} slot="start" />
              <IonLabel>
                <h2>Corryong T2.xctsk</h2>
                <p>96.1 km race · 6 Jan 2026</p>
              </IonLabel>
            </IonItem>
            <IonItem>
              <IonIcon icon={folderOpenOutline} slot="start" />
              <IonLabel>
                <h2>Kosciuszko loop.xctsk</h2>
                <p>Free distance</p>
              </IonLabel>
            </IonItem>
          </IonList>
        )}
        <p className="muted" style={{ padding: "8px 20px" }}>
          Swipe a track left to delete. The confirm is an Ionic alert — the same
          job the RAC alertdialog does today.
        </p>
      </IonContent>
    </IonPage>
  );
};

export default FlightsPage;
