import { useParams } from "react-router-dom";
import {
  IonBackButton,
  IonBadge,
  IonButton,
  IonButtons,
  IonChip,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonActionSheet,
  useIonToast,
} from "@ionic/react";
import {
  analyticsOutline,
  cloudDownloadOutline,
  cloudUploadOutline,
  playOutline,
  settingsOutline,
  shareOutline,
  sunnyOutline,
} from "ionicons/icons";
import { TURNPOINTS, formatRadius, getComp, getTask } from "@/data/mock";
import { MapPlaceholder } from "@/components/ui";
import { usePrefs } from "@/state/prefs";

const WIND_COLOUR = {
  tail: "success",
  cross: "warning",
  head: "danger",
} as const;

const TaskPage: React.FC = () => {
  const { compId, taskId } = useParams<{ compId: string; taskId: string }>();
  const comp = getComp(compId);
  const task = getTask(taskId);
  const { role, formatAltitude, formatDistance } = usePrefs();
  const [sheet] = useIonActionSheet();
  const [toast] = useIonToast();

  if (!comp || !task) {
    return (
      <IonPage>
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              <IonBackButton defaultHref="/tabs/comps" />
            </IonButtons>
            <IonTitle>Task not found</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding">That task is not in the mock set.</IonContent>
      </IonPage>
    );
  }

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref={`/tabs/comps/${comp.id}`} text="Comp" />
          </IonButtons>
          <IonTitle>{task.name}</IonTitle>
          <IonButtons slot="end">
            <IonButton
              aria-label="Share task"
              onClick={() =>
                void sheet({
                  header: task.name,
                  buttons: [
                    { text: "Download .xctsk", handler: () => void toast({ message: "Would download the task file.", duration: 1400 }) },
                    { text: "Copy link", handler: () => void toast({ message: "Link copied (mocked).", duration: 1400 }) },
                    { text: "Cancel", role: "cancel" },
                  ],
                })
              }
            >
              <IonIcon slot="icon-only" icon={shareOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <MapPlaceholder caption={`${formatDistance(task.distanceKm)} race · SSS ${task.start}`} />

        <div className="ion-padding">
          <h1 style={{ margin: "4px 0 8px", fontSize: 22, fontWeight: 700 }}>{task.name}</h1>
          <div className="fact-row">
            {task.classes.map((c) => (
              <IonChip key={c}>{c}</IonChip>
            ))}
            <IonChip outline>{formatDistance(task.distanceKm)}</IonChip>
            <IonChip outline>SSS {task.start}</IonChip>
            <IonChip outline>Goal {task.goalDeadline}</IonChip>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
            <IonButton
              expand="block"
              routerLink="/tabs/submit"
              onClick={() => void toast({ message: "Submit tab opens with this task prefilled.", duration: 1600 })}
            >
              <IonIcon slot="start" icon={cloudUploadOutline} />
              Submit track
            </IonButton>
            <IonButton
              expand="block"
              fill="outline"
              onClick={() => void toast({ message: "3D replay would open full-screen.", duration: 1600 })}
            >
              <IonIcon slot="start" icon={playOutline} />
              3D replay
            </IonButton>
          </div>
          <IonButton
            expand="block"
            fill="clear"
            onClick={() => void toast({ message: "Would download the .xctsk for XCTrack / SeeYou.", duration: 1800 })}
          >
            <IonIcon slot="start" icon={cloudDownloadOutline} />
            Download .xctsk
          </IonButton>
        </div>

        <p className="section-label">Turnpoints</p>
        <IonList inset>
          {TURNPOINTS.map((tp, i) => (
            <IonItem
              key={`${tp.role}-${i}`}
              button
              onClick={() => void toast({ message: `Map would pan to ${tp.code}.`, duration: 1200 })}
            >
              <IonBadge slot="start" color={tp.role === "TAKEOFF" ? "warning" : tp.role === "GOAL" ? "success" : "primary"}>
                {tp.role}
              </IonBadge>
              <IonLabel>
                <h2>
                  {tp.code}{" "}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {formatRadius(tp.radiusM)} · {formatAltitude(tp.altitudeM)}
                  </span>
                </h2>
                <p>{tp.coords}</p>
              </IonLabel>
              {tp.legKm != null ? (
                <IonNote slot="end">
                  <span className="tabular">{tp.legKm.toFixed(1)} km</span>
                  {tp.wind ? (
                    <>
                      <br />
                      <IonBadge color={WIND_COLOUR[tp.wind]}>{tp.wind}</IonBadge>
                    </>
                  ) : null}
                </IonNote>
              ) : null}
            </IonItem>
          ))}
          <IonItem>
            <IonLabel>
              <h2>Optimised total</h2>
            </IonLabel>
            <IonNote slot="end" className="tabular">
              {formatDistance(task.distanceKm)}
            </IonNote>
          </IonItem>
        </IonList>

        <p className="section-label">Weather</p>
        <IonList inset>
          <IonItem routerLink={`/tabs/comps/${comp.id}/task/${task.id}/weather`} detail>
            <IonIcon icon={sunnyOutline} slot="start" color="warning" />
            <IonLabel>
              <h2>NW 18 km/h · base 2,400 m</h2>
              <p>Organiser note: “Cu over the plateau after 13:00. Last start 16:30.”</p>
            </IonLabel>
          </IonItem>
        </IonList>

        <p className="section-label">Results</p>
        <IonList inset>
          <IonItem routerLink={`/tabs/comps/${comp.id}/scores`} detail>
            <IonLabel>
              <h2>Open — Jon Durand 912</h2>
              <p>Rohan Holtkamp 888 · Grant Gunn 870</p>
            </IonLabel>
          </IonItem>
          <IonItem routerLink={`/tabs/comps/${comp.id}/analysis`} detail>
            <IonIcon icon={analyticsOutline} slot="start" />
            <IonLabel>Task analysis</IonLabel>
          </IonItem>
        </IonList>

        {role === "organiser" ? (
          <>
            <p className="section-label">Manage</p>
            <IonList inset>
              <IonItem routerLink={`/tabs/comps/${comp.id}/task/${task.id}/route`} detail>
                <IonLabel>Edit route</IonLabel>
              </IonItem>
              <IonItem
                button
                onClick={() => void toast({ message: "Task settings sheet would open.", duration: 1400 })}
              >
                <IonIcon icon={settingsOutline} slot="start" />
                <IonLabel>Task settings</IonLabel>
              </IonItem>
            </IonList>
          </>
        ) : null}
        <div style={{ height: 24 }} />
      </IonContent>
    </IonPage>
  );
};

export default TaskPage;
