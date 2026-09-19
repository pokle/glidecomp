import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonReorder,
  IonReorderGroup,
  IonTitle,
  IonToolbar,
  type ReorderEndEventDetail,
} from "@ionic/react";
import { TURNPOINTS } from "@/data/mock";
import { MapPlaceholder } from "@/components/ui";

const RouteEditorPage: React.FC = () => {
  const { compId, taskId } = useParams<{ compId: string; taskId: string }>();
  const [points, setPoints] = useState(TURNPOINTS);

  function onReorder(ev: CustomEvent<ReorderEndEventDetail>) {
    setPoints(ev.detail.complete(points));
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref={`/tabs/comps/${compId}/task/${taskId}`} text="Task" />
          </IonButtons>
          <IonTitle>Edit route</IonTitle>
          <IonButtons slot="end">
            <IonButton strong>Save</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <MapPlaceholder caption="Drag the list to reorder turnpoints" height={160} />
        <p className="muted" style={{ padding: "12px 16px 0" }}>
          Long-press the handle. The real editor is a map plus an enter-task
          field; this is the phone shape of that list.
        </p>
        <IonList inset>
          <IonReorderGroup disabled={false} onIonReorderEnd={onReorder}>
            {points.map((tp, i) => (
              <IonItem key={`${tp.role}-${i}`}>
                <IonLabel>
                  <h2>
                    {tp.role} · {tp.code}
                  </h2>
                  <p>
                    {tp.radiusM} m · {tp.coords}
                  </p>
                </IonLabel>
                <IonNote slot="end">{tp.legKm ? `${tp.legKm.toFixed(1)} km` : ""}</IonNote>
                <IonReorder slot="end" />
              </IonItem>
            ))}
          </IonReorderGroup>
        </IonList>
        <div className="ion-padding">
          <IonButton expand="block" fill="outline">
            Add turnpoint
          </IonButton>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default RouteEditorPage;
