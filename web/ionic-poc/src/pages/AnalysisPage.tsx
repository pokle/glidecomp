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
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { ANALYSIS, getComp } from "@/data/mock";

const AnalysisPage: React.FC = () => {
  const { compId } = useParams<{ compId: string }>();
  const comp = getComp(compId);

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref={`/tabs/comps/${compId}`} text="Comp" />
          </IonButtons>
          <IonTitle>Task analysis</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <p className="ion-padding" style={{ paddingBottom: 0 }}>
          {comp?.name}: Task 2 — Open. Each box is one page. The box names the
          section and states one fact; the explanation lives on the other side.
        </p>
        <IonList inset>
          {ANALYSIS.map((box) => (
            <IonItem
              key={box.slug}
              routerLink={`/tabs/comps/${compId}/analysis/${box.slug}`}
              detail
            >
              <IonLabel className="ion-text-wrap">
                <h2>{box.label}</h2>
                <p>{box.fact}</p>
              </IonLabel>
            </IonItem>
          ))}
        </IonList>
        <IonNote className="ion-padding">
          Presentation order is fixed: the behaviours that separated the field,
          then the day, then the per-pilot tables.
        </IonNote>
      </IonContent>
    </IonPage>
  );
};

export default AnalysisPage;
