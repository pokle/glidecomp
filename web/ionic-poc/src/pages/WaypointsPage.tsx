import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonPage,
  IonSearchbar,
  IonTitle,
  IonToolbar,
  useIonToast,
} from "@ionic/react";
import { locateOutline } from "ionicons/icons";
import { WAYPOINTS, formatRadius, getComp, type Waypoint } from "@/data/mock";
import { MapPlaceholder } from "@/components/ui";
import { usePrefs } from "@/state/prefs";

const WaypointsPage: React.FC = () => {
  const { compId } = useParams<{ compId: string }>();
  const comp = getComp(compId);
  const { role, formatAltitude } = usePrefs();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Waypoint | null>(null);
  const [review, setReview] = useState(false);
  const [toast] = useIonToast();
  const [focused, setFocused] = useState<string>("ELLIOT");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return WAYPOINTS.filter(
      (w) => !q || `${w.code} ${w.name}`.toLowerCase().includes(q)
    );
  }, [query]);

  const findings = WAYPOINTS.filter((w) => {
    if (w.altitudeM === undefined) return true;
    return Math.abs(w.altitudeM - w.mapAltitudeM) >= 50;
  });

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref={`/tabs/comps/${compId}`} text="Comp" />
          </IonButtons>
          <IonTitle>Waypoints</IonTitle>
          {role === "organiser" ? (
            <IonButtons slot="end">
              <IonButton onClick={() => setReview(true)}>Check altitudes</IonButton>
            </IonButtons>
          ) : null}
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <MapPlaceholder caption={`Showing ${focused}`} height={180} />
        <IonSearchbar
          value={query}
          debounce={0}
          placeholder="Filter waypoints"
          onIonInput={(e) => setQuery(e.detail.value ?? "")}
        />
        <IonList inset>
          {rows.map((row) => (
            <IonItem
              key={row.id}
              button
              detail={role === "organiser"}
              onClick={() => {
                if (role === "organiser") setOpen(row);
                else {
                  setFocused(row.code);
                  void toast({ message: `Map flew to ${row.code}.`, duration: 1100 });
                }
              }}
            >
              <IonButton
                slot="start"
                fill="clear"
                aria-label={`Show ${row.code} on the map`}
                onClick={(e) => {
                  e.stopPropagation();
                  setFocused(row.code);
                  void toast({ message: `Map flew to ${row.code}.`, duration: 1100 });
                }}
              >
                <IonIcon slot="icon-only" icon={locateOutline} />
              </IonButton>
              <IonLabel>
                <h2>
                  {row.code} · {row.name}
                </h2>
                <p>
                  {row.coords}
                  {" · "}
                  {row.altitudeM === undefined
                    ? "altitude unknown"
                    : formatAltitude(row.altitudeM)}
                  {" · "}
                  {formatRadius(row.radiusM)}
                </p>
              </IonLabel>
            </IonItem>
          ))}
        </IonList>
        <p className="muted" style={{ padding: "8px 20px 28px" }}>
          {comp?.name}: {WAYPOINTS.length} waypoints. Read-only, the whole row
          flies the map. Organisers tap a row to open a sheet.
        </p>
      </IonContent>

      <IonModal
        isOpen={open !== null}
        onDidDismiss={() => setOpen(null)}
        breakpoints={[0, 0.55, 0.95]}
        initialBreakpoint={0.95}
      >
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              <IonButton onClick={() => setOpen(null)}>Back</IonButton>
            </IonButtons>
            <IonTitle>{open?.code}</IonTitle>
            <IonButtons slot="end">
              <IonButton strong onClick={() => setOpen(null)}>
                Done
              </IonButton>
            </IonButtons>
          </IonToolbar>
        </IonHeader>
        <IonContent>
          <IonList inset>
            <IonItem>
              <IonInput label="Code" value={open?.code} />
            </IonItem>
            <IonItem>
              <IonInput label="Name" value={open?.name} />
            </IonItem>
            <IonItem>
              <IonInput label="Coordinates" value={open?.coords} />
            </IonItem>
            <IonItem>
              <IonInput
                label="Altitude (m)"
                value={open?.altitudeM === undefined ? "" : String(open.altitudeM)}
                placeholder="Leave blank if unknown"
              />
            </IonItem>
            <IonItem>
              <IonInput label="Radius (m)" value={open ? String(open.radiusM) : ""} />
            </IonItem>
          </IonList>
          <p className="muted" style={{ padding: "0 20px" }}>
            A zero altitude is sea level, not missing. An empty field is the only
            “unknown” signal. Cylinder radii stay in metres.
          </p>
        </IonContent>
      </IonModal>

      <IonModal isOpen={review} onDidDismiss={() => setReview(false)}>
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              <IonButton onClick={() => setReview(false)}>Back</IonButton>
            </IonButtons>
            <IonTitle>Altitude review</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent>
          <p className="ion-padding">
            Check altitudes reports nothing until you press it. Each finding
            states both altitudes.
          </p>
          <IonList inset>
            {findings.map((w) => (
              <IonItem key={w.id}>
                <IonLabel>
                  <h2>{w.code}</h2>
                  <p>
                    File: {w.altitudeM === undefined ? "unknown" : `${w.altitudeM} m`}
                    {" · "}
                    Map: {w.mapAltitudeM} m
                  </p>
                </IonLabel>
                <IonNote slot="end" color="danger">
                  {w.altitudeM === undefined
                    ? "missing"
                    : `${w.mapAltitudeM - w.altitudeM > 0 ? "+" : ""}${w.mapAltitudeM - w.altitudeM} m`}
                </IonNote>
              </IonItem>
            ))}
          </IonList>
          <div className="ion-padding">
            <IonButton expand="block" onClick={() => setReview(false)}>
              Accept selected
            </IonButton>
          </div>
        </IonContent>
      </IonModal>
    </IonPage>
  );
};

export default WaypointsPage;
