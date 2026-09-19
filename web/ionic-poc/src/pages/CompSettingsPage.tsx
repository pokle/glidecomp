import { useParams } from "react-router-dom";
import {
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonDatetime,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonNote,
  IonPage,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
  useIonToast,
} from "@ionic/react";
import { BackLink } from "@/components/ui";
import { getComp } from "@/data/mock";

const CompSettingsPage: React.FC = () => {
  const { compId } = useParams<{ compId: string }>();
  const comp = getComp(compId);
  const [toast] = useIonToast();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <BackLink href={`/tabs/comps/${compId}`}>Comp</BackLink>
          <IonTitle>Competition settings</IonTitle>
          <IonButtons slot="end">
            <IonButton
              strong
              onClick={() => void toast({ message: "Saved (mocked).", duration: 1200 })}
            >
              Save
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <p className="section-label">Identity</p>
        <IonList inset>
          <IonItem>
            <IonInput label="Name" value={comp?.name} />
          </IonItem>
          <IonItem>
            <IonSelect label="Wing" interface="action-sheet" value={comp?.category ?? "hg"}>
              <IonSelectOption value="hg">Hang gliding</IonSelectOption>
              <IonSelectOption value="pg">Paragliding</IonSelectOption>
            </IonSelect>
          </IonItem>
          <IonItem>
            <IonSelect label="Scoring" interface="action-sheet" value={comp?.scoringFormat ?? "gap"}>
              <IonSelectOption value="gap">GAP</IonSelectOption>
              <IonSelectOption value="open_distance">Open distance</IonSelectOption>
            </IonSelect>
          </IonItem>
          <IonItem>
            <IonToggle justify="space-between" checked={!!comp?.test}>
              Hidden test competition
            </IonToggle>
          </IonItem>
        </IonList>

        <p className="section-label">Classes</p>
        <IonList inset>
          <IonItem>
            <IonCheckbox justify="space-between" checked>
              Open
            </IonCheckbox>
          </IonItem>
          <IonItem>
            <IonCheckbox justify="space-between" checked>
              Floater
            </IonCheckbox>
          </IonItem>
          <IonItem>
            <IonCheckbox justify="space-between">Sport</IonCheckbox>
          </IonItem>
        </IonList>

        <p className="section-label">When</p>
        <IonList inset>
          <IonItem>
            <IonDatetime presentation="date" value="2026-01-10" locale="en-AU" />
          </IonItem>
        </IonList>
        <IonNote className="ion-padding">Close date — after this, pilots cannot submit.</IonNote>

        <p className="section-label">Notes</p>
        <IonList inset>
          <IonItem>
            <IonTextarea
              label="Public notes"
              autoGrow
              value="Briefing 10:00 at the hangar. Retrieve on 0400 000 000."
            />
          </IonItem>
        </IonList>
        <div style={{ height: 32 }} />
      </IonContent>
    </IonPage>
  );
};

export default CompSettingsPage;
