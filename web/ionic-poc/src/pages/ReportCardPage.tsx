import {
  IonAccordion,
  IonAccordionGroup,
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
import { useParams } from "react-router-dom";
import { REPORT } from "@/data/mock";
import { CleaningChart, DistanceChart, MapPlaceholder } from "@/components/ui";

const ReportCardPage: React.FC = () => {
  const { compId } = useParams<{ compId: string }>();

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref={`/tabs/comps/${compId}/scores`} text="Scores" />
          </IonButtons>
          <IonTitle>Report card</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <MapPlaceholder caption={`${REPORT.name} · ${REPORT.taskName}`} height={200} />
        <div className="ion-padding">
          <IonBadge color="primary">{REPORT.rank}st</IonBadge>
          <h1 style={{ margin: "8px 0 4px", fontSize: 24 }}>{REPORT.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {REPORT.taskName}
          </p>
          <p style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: "tabular-nums", margin: "12px 0 4px" }}>
            {REPORT.points}
            <span className="muted" style={{ fontSize: 16, fontWeight: 500 }}>
              {" "}
              / {REPORT.available}
            </span>
          </p>
          <p style={{ marginTop: 0 }}>{REPORT.headline}</p>
        </div>

        <IonAccordionGroup multiple value={["flight", "day", "distance"]}>
          {REPORT.sections.map((section) => (
            <IonAccordion key={section.id} value={section.id}>
              <IonItem slot="header">
                <IonLabel>
                  <h2>{section.title}</h2>
                  {section.points != null ? (
                    <p className="tabular">
                      {section.points}
                      {section.available != null ? ` of ${section.available}` : ""} points
                    </p>
                  ) : (
                    <p>Inputs and substituted arithmetic</p>
                  )}
                </IonLabel>
              </IonItem>
              <div slot="content">
                <IonList>
                  {section.items.map((item) => (
                    <IonItem key={item.text} lines="inset">
                      <IonLabel className="ion-text-wrap">
                        <h2>{item.text}</h2>
                        {item.arith ? <div className="explain-arith">{item.arith}</div> : null}
                      </IonLabel>
                      {item.value ? (
                        <IonNote slot="end" className="tabular">
                          {item.value}
                        </IonNote>
                      ) : null}
                    </IonItem>
                  ))}
                </IonList>
                {section.id === "distance" ? (
                  <div className="ion-padding">
                    <DistanceChart />
                  </div>
                ) : null}
                {section.id === "cleaning" ? (
                  <div className="ion-padding">
                    <CleaningChart />
                  </div>
                ) : null}
              </div>
            </IonAccordion>
          ))}
        </IonAccordionGroup>
        <p className="muted" style={{ padding: "16px 20px 32px" }}>
          Every section that states a rule names its inputs and prints the
          substituted arithmetic — the same contract as the RAC report card.
        </p>
      </IonContent>
    </IonPage>
  );
};

export default ReportCardPage;
