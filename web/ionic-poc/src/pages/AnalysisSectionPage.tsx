import { useParams } from "react-router-dom";
import {
  IonBackButton,
  IonBadge,
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
import { ANALYSIS } from "@/data/mock";
import { DistanceChart } from "@/components/ui";

const METRIC_ROWS = [
  { name: "Jon Durand", value: "2.4 m/s", rank: 1 },
  { name: "Rohan Holtkamp", value: "2.1 m/s", rank: 2 },
  { name: "Grant Gunn", value: "1.9 m/s", rank: 6 },
  { name: "Tove Heaney", value: "1.7 m/s", rank: 11 },
];

const AnalysisSectionPage: React.FC = () => {
  const { compId, section } = useParams<{ compId: string; section: string }>();
  const def = ANALYSIS.find((a) => a.slug === section);

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref={`/tabs/comps/${compId}/analysis`} text="Analysis" />
          </IonButtons>
          <IonTitle>{def?.label ?? "Section"}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <p className="ion-padding">{def?.fact}</p>
        {section === "strategies" || section === "metrics" ? (
          <>
            <div className="ion-padding" style={{ paddingTop: 0 }}>
              <DistanceChart />
            </div>
            <IonList inset>
              {METRIC_ROWS.map((row) => (
                <IonItem key={row.name}>
                  <IonBadge slot="start">{row.rank}</IonBadge>
                  <IonLabel>{row.name}</IonLabel>
                  <IonNote slot="end" className="tabular">
                    {row.value}
                  </IonNote>
                </IonItem>
              ))}
            </IonList>
          </>
        ) : section === "weather" ? (
          <IonList inset>
            <IonItem>
              <IonLabel>
                <h2>Wind</h2>
                <p>NW 18–22 km/h, gusting 28 at ridge height</p>
              </IonLabel>
            </IonItem>
            <IonItem>
              <IonLabel>
                <h2>Cloudbase</h2>
                <p>2,400 m by 14:00</p>
              </IonLabel>
            </IonItem>
            <IonItem>
              <IonLabel className="ion-text-wrap">
                <h2>Organiser note</h2>
                <p>
                  Cu over the plateau after 13:00. Last start 16:30. Goal
                  deadline brought forward 30 minutes.
                </p>
              </IonLabel>
            </IonItem>
          </IonList>
        ) : (
          <IonList inset>
            <IonItem>
              <IonLabel className="ion-text-wrap">
                <h2>{def?.label}</h2>
                <p>
                  This section is stubbed in the POC. The real page would carry
                  the tables and charts for this chapter only.
                </p>
              </IonLabel>
            </IonItem>
          </IonList>
        )}
      </IonContent>
    </IonPage>
  );
};

export default AnalysisSectionPage;
