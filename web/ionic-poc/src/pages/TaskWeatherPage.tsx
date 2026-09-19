import { useParams } from "react-router-dom";
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonRange,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from "@ionic/react";

const TaskWeatherPage: React.FC = () => {
  const { compId, taskId } = useParams<{ compId: string; taskId: string }>();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref={`/tabs/comps/${compId}/task/${taskId}`} text="Task" />
          </IonButtons>
          <IonTitle>Weather</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <p className="ion-padding">
          A prediction is never read as a record. Every figure names its source.
        </p>
        <IonList inset>
          <IonItem>
            <IonLabel>
              <h2>Model wind</h2>
              <p>Open-Meteo · NW 18 km/h at 1,500 m</p>
            </IonLabel>
          </IonItem>
          <IonItem>
            <IonRange label="Wind used for legs" min={0} max={40} value={18} pin />
          </IonItem>
          <IonItem>
            <IonTextarea
              label="Organiser note"
              autoGrow
              value="Cu over the plateau after 13:00. Last start 16:30."
            />
          </IonItem>
        </IonList>
        <IonNote className="ion-padding">
          The range is how an organiser would nudge the wind used to colour the
          head/tail badges on the turnpoint list.
        </IonNote>
      </IonContent>
    </IonPage>
  );
};

export default TaskWeatherPage;
