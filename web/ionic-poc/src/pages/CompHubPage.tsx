import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  IonAccordion,
  IonAccordionGroup,
  IonBadge,
  IonButton,
  IonButtons,
  IonChip,
  IonContent,
  IonFab,
  IonFabButton,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonActionSheet,
  useIonToast,
} from "@ionic/react";
import {
  addOutline,
  analyticsOutline,
  ellipsisHorizontal,
  flagOutline,
  listOutline,
  peopleOutline,
  settingsOutline,
  shareOutline,
  trophyOutline,
} from "ionicons/icons";
import {
  ACTIVITY,
  formatDate,
  getComp,
  scoresFor,
  tasksFor,
} from "@/data/mock";
import { MapPlaceholder, Podium, RoleOnly } from "@/components/ui";
import { usePrefs } from "@/state/prefs";

const CompHubPage: React.FC = () => {
  const { compId } = useParams<{ compId: string }>();
  const comp = getComp(compId);
  const { formatDistance } = usePrefs();
  const [sheet] = useIonActionSheet();
  const [toast] = useIonToast();
  const [createHint, setCreateHint] = useState(false);

  const tasks = tasksFor(compId);
  const byDate = useMemo(() => {
    const map = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const list = map.get(t.date) ?? [];
      list.push(t);
      map.set(t.date, list);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [tasks]);

  if (!comp) {
    return (
      <IonPage>
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              <IonButton routerLink="/tabs/comps" routerDirection="back">
                Back
              </IonButton>
            </IonButtons>
            <IonTitle>Not found</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding">That competition is not in the mock set.</IonContent>
      </IonPage>
    );
  }

  const openTop = scoresFor("Open").slice(0, 3).map((s) => ({
    id: s.pilotId,
    name: s.name,
    points: s.total,
  }));

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonButton routerLink="/tabs/comps" routerDirection="back">
              Comps
            </IonButton>
          </IonButtons>
          <IonTitle>{comp.name}</IonTitle>
          <IonButtons slot="end">
            <IonButton
              aria-label="Share"
              onClick={() =>
                void sheet({
                  header: "Share this competition",
                  buttons: [
                    { text: "Copy link", handler: () => void toast({ message: "Link copied (mocked).", duration: 1400 }) },
                    { text: "Show QR code", handler: () => void toast({ message: "QR would open full-screen.", duration: 1400 }) },
                    { text: "Download waypoints", handler: () => void toast({ message: "Would download a .wpt file.", duration: 1400 }) },
                    { text: "Cancel", role: "cancel" },
                  ],
                })
              }
            >
              <IonIcon slot="icon-only" icon={shareOutline} />
            </IonButton>
            <RoleOnly organiser>
              <IonButton routerLink={`/tabs/comps/${comp.id}/settings`}>
                <IonIcon slot="icon-only" icon={settingsOutline} />
              </IonButton>
            </RoleOnly>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <MapPlaceholder caption={`${comp.place} · ${comp.timezone}`} />

        <div className="ion-padding-horizontal ion-padding-top">
          <h1 style={{ margin: "8px 0 4px", fontSize: 26, fontWeight: 700 }}>{comp.name}</h1>
          <div className="fact-row">
            <IonChip>{comp.category === "hg" ? "Hang gliding" : "Paragliding"}</IonChip>
            <IonChip>{comp.scoringFormat === "gap" ? "GAP" : "Open distance"}</IonChip>
            {comp.classes.map((c) => (
              <IonChip key={c} outline>
                {c}
              </IonChip>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "4px 12px 12px" }}>
          <IonButton size="small" routerLink={`/tabs/comps/${comp.id}/scores`}>
            <IonIcon slot="start" icon={trophyOutline} />
            Scores
          </IonButton>
          <IonButton size="small" fill="outline" routerLink={`/tabs/comps/${comp.id}/waypoints`}>
            <IonIcon slot="start" icon={flagOutline} />
            Waypoints ({comp.waypointCount})
          </IonButton>
          {comp.scoringFormat === "gap" ? (
            <IonButton size="small" fill="outline" routerLink={`/tabs/comps/${comp.id}/analysis`}>
              <IonIcon slot="start" icon={analyticsOutline} />
              Analysis
            </IonButton>
          ) : null}
          <RoleOnly organiser>
            <IonButton size="small" fill="outline" routerLink={`/tabs/comps/${comp.id}/pilots`}>
              <IonIcon slot="start" icon={peopleOutline} />
              Pilots ({comp.pilotCount})
            </IonButton>
          </RoleOnly>
        </div>

        <p className="section-label">Scores</p>
        <div className="ion-padding-horizontal">
          <Podium rows={openTop} />
          <IonButton expand="block" fill="outline" routerLink={`/tabs/comps/${comp.id}/scores`}>
            Full scores
          </IonButton>
        </div>

        <p className="section-label">Tasks ({tasks.length})</p>
        <IonAccordionGroup multiple value={byDate.map(([d]) => d)}>
          {byDate.map(([date, dayTasks]) => (
            <IonAccordion key={date} value={date}>
              <IonItem slot="header">
                <IonIcon icon={listOutline} slot="start" />
                <IonLabel>
                  <h2>{formatDate(date)}</h2>
                  <p>
                    {dayTasks.length} {dayTasks.length === 1 ? "task" : "tasks"}
                  </p>
                </IonLabel>
              </IonItem>
              <div slot="content">
                <IonList lines="full">
                  {dayTasks.map((task) => (
                    <IonItem
                      key={task.id}
                      routerLink={`/tabs/comps/${comp.id}/task/${task.id}`}
                      detail
                    >
                      <IonLabel>
                        <h2>{task.name}</h2>
                        <p>
                          {formatDistance(task.distanceKm)} · SSS {task.start} · Goal{" "}
                          {task.goalDeadline}
                        </p>
                      </IonLabel>
                      <IonBadge color={task.status === "scored" ? "success" : "warning"} slot="end">
                        {task.classes.join(", ")}
                      </IonBadge>
                    </IonItem>
                  ))}
                </IonList>
              </div>
            </IonAccordion>
          ))}
        </IonAccordionGroup>

        <p className="section-label">Activity</p>
        <IonList inset>
          {ACTIVITY.map((a) => (
            <IonItem key={a.text}>
              <IonIcon icon={ellipsisHorizontal} slot="start" color="medium" />
              <IonLabel>
                <h2>{a.text}</h2>
                <p>{a.when}</p>
              </IonLabel>
            </IonItem>
          ))}
        </IonList>
        <p className="muted" style={{ padding: "0 20px 32px" }}>
          Organised by Tushar Pokle.
        </p>

        <RoleOnly organiser>
          <IonFab slot="fixed" vertical="bottom" horizontal="end">
            <IonFabButton
              onClick={() => {
                setCreateHint(true);
                void toast({
                  message: createHint
                    ? "A New Task sheet would open here."
                    : "New Task — date defaults to today.",
                  duration: 1800,
                });
              }}
              aria-label="New task"
            >
              <IonIcon icon={addOutline} />
            </IonFabButton>
          </IonFab>
        </RoleOnly>
      </IonContent>
    </IonPage>
  );
};

export default CompHubPage;
