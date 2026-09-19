import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
  useIonToast,
} from "@ionic/react";
import { getComp, scoresFor, type PilotClass } from "@/data/mock";
import { BackLink, Podium } from "@/components/ui";
import { usePrefs } from "@/state/prefs";

const ScoresPage: React.FC = () => {
  const { compId } = useParams<{ compId: string }>();
  const comp = getComp(compId);
  const { role } = usePrefs();
  const [klass, setKlass] = useState<PilotClass>("Open");
  const [view, setView] = useState<"scores" | "top3" | "teams">("scores");
  const [toast] = useIonToast();
  const rows = useMemo(() => scoresFor(klass), [klass]);
  const teams = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      if (!r.team) continue;
      map.set(r.team, (map.get(r.team) ?? 0) + r.total);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <BackLink href={`/tabs/comps/${compId}`}>Comp</BackLink>
          <IonTitle>Scores</IonTitle>
          <IonButtons slot="end">
            <IonButton
              onClick={() => void toast({ message: "Would download scores.csv.", duration: 1400 })}
            >
              CSV
            </IonButton>
            {role === "organiser" ? (
              <IonButton
                onClick={() => void toast({ message: "Would recompute scores and mark them stale.", duration: 1800 })}
              >
                Recompute
              </IonButton>
            ) : null}
          </IonButtons>
        </IonToolbar>
        <IonToolbar>
          <IonSegment
            value={klass}
            onIonChange={(e) => setKlass((e.detail.value as PilotClass) || "Open")}
          >
            <IonSegmentButton value="Open">Open</IonSegmentButton>
            <IonSegmentButton value="Floater">Floater</IonSegmentButton>
          </IonSegment>
        </IonToolbar>
        <IonToolbar>
          <IonSegment
            value={view}
            onIonChange={(e) => setView((e.detail.value as typeof view) || "scores")}
          >
            <IonSegmentButton value="scores">Scores</IonSegmentButton>
            <IonSegmentButton value="top3">Top 3</IonSegmentButton>
            <IonSegmentButton value="teams">Teams</IonSegmentButton>
          </IonSegment>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonRefresher
          slot="fixed"
          onIonRefresh={(ev) => {
            setTimeout(() => {
              ev.detail.complete();
              void toast({ message: "Scores are mocked.", duration: 1200 });
            }, 600);
          }}
        >
          <IonRefresherContent />
        </IonRefresher>

        <p className="muted" style={{ padding: "12px 16px 0" }}>
          {comp?.name} · computed 16:52 · not stale
        </p>

        {view === "top3" ? (
          <div className="ion-padding">
            <Podium
              rows={rows.slice(0, 3).map((r) => ({
                id: r.pilotId,
                name: r.name,
                points: r.total,
              }))}
            />
          </div>
        ) : null}

        {view === "teams" ? (
          <IonList inset>
            {teams.map(([name, pts], i) => (
              <IonItem key={name}>
                <IonBadge slot="start">{i + 1}</IonBadge>
                <IonLabel>{name}</IonLabel>
                <IonNote slot="end" className="tabular">
                  {pts}
                </IonNote>
              </IonItem>
            ))}
          </IonList>
        ) : (
          <IonList inset>
            {rows.map((row) => (
              <IonItem
                key={row.pilotId}
                routerLink={`/tabs/comps/${compId}/task/t2/pilot/${row.pilotId}`}
                detail
              >
                <IonBadge slot="start" color={row.rank === 1 ? "primary" : "medium"}>
                  {row.rank}
                </IonBadge>
                <IonLabel>
                  <h2>
                    {row.name}{" "}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {row.nation}
                    </span>
                  </h2>
                  <p className="tabular">
                    T1 {row.t1} · T2 {row.t2} · T3 {row.t3}
                  </p>
                </IonLabel>
                <IonNote slot="end" className="tabular" color="dark">
                  {row.total}
                </IonNote>
              </IonItem>
            ))}
          </IonList>
        )}
        <p className="muted" style={{ padding: "8px 20px 28px" }}>
          Tap a pilot for their report card. The desktop scores grid is a table;
          this is the same data as a list a thumb can scroll.
        </p>
      </IonContent>
    </IonPage>
  );
};

export default ScoresPage;
