import { useState } from "react";
import {
  IonAccordion,
  IonAccordionGroup,
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonCheckbox,
  IonChip,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonInputOtp,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonProgressBar,
  IonRadio,
  IonRadioGroup,
  IonRange,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonSkeletonText,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
  useIonActionSheet,
  useIonAlert,
  useIonToast,
} from "@ionic/react";
import { BackLink } from "@/components/ui";
import { checkmarkCircle, warningOutline } from "ionicons/icons";

const KitGalleryPage: React.FC = () => {
  const [seg, setSeg] = useState("one");
  const [toast] = useIonToast();
  const [alert] = useIonAlert();
  const [sheet] = useIonActionSheet();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <BackLink href="/tabs/me">Me</BackLink>
          <IonTitle>Ionic kit</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <p className="ion-padding">
          Every control this POC uses, in one place, so you can feel the kit
          without hunting through screens.
        </p>

        <div className="kit-block">
          <h2>Buttons</h2>
          <IonButton>Solid</IonButton>
          <IonButton fill="outline">Outline</IonButton>
          <IonButton fill="clear">Clear</IonButton>
          <IonButton color="danger">Danger</IonButton>
          <IonButton disabled>Disabled</IonButton>
        </div>

        <div className="kit-block">
          <h2>Chips and badges</h2>
          <IonChip>Hang gliding</IonChip>
          <IonChip outline color="primary">
            GAP
          </IonChip>
          <IonBadge color="success">scored</IonBadge>
          <IonBadge color="warning">DNF</IonBadge>
          <IonBadge color="danger">stale</IonBadge>
        </div>

        <div className="kit-block">
          <h2>Segment</h2>
          <IonSegment value={seg} onIonChange={(e) => setSeg(String(e.detail.value))}>
            <IonSegmentButton value="one">Scores</IonSegmentButton>
            <IonSegmentButton value="two">Top 3</IonSegmentButton>
            <IonSegmentButton value="three">Teams</IonSegmentButton>
          </IonSegment>
        </div>

        <div className="kit-block">
          <h2>Feedback</h2>
          <IonButton
            fill="outline"
            onClick={() => void toast({ message: "Track accepted.", duration: 1500, color: "success" })}
          >
            Toast
          </IonButton>
          <IonButton
            fill="outline"
            onClick={() =>
              void alert({
                header: "Discard changes?",
                message: "The route editor has unsaved work.",
                buttons: [
                  { text: "Keep editing", role: "cancel" },
                  { text: "Discard", role: "destructive" },
                ],
              })
            }
          >
            Alert
          </IonButton>
          <IonButton
            fill="outline"
            onClick={() =>
              void sheet({
                header: "Share",
                buttons: [
                  { text: "Copy link" },
                  { text: "QR code" },
                  { text: "Cancel", role: "cancel" },
                ],
              })
            }
          >
            Action sheet
          </IonButton>
        </div>

        <div className="kit-block">
          <h2>Progress</h2>
          <IonProgressBar value={0.42} />
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
            <IonSpinner name="crescent" />
            <IonSkeletonText animated style={{ width: "60%", height: 14 }} />
          </div>
        </div>

        <div className="kit-block">
          <h2>Forms</h2>
          <IonList inset={false}>
            <IonItem>
              <IonInput label="Name" placeholder="Corryong Cup" />
            </IonItem>
            <IonItem>
              <IonSelect label="Class" interface="action-sheet" value="Open">
                <IonSelectOption value="Open">Open</IonSelectOption>
                <IonSelectOption value="Floater">Floater</IonSelectOption>
              </IonSelect>
            </IonItem>
            <IonItem>
              <IonToggle justify="space-between">Hidden test comp</IonToggle>
            </IonItem>
            <IonItem>
              <IonCheckbox justify="space-between">Notify the pilot</IonCheckbox>
            </IonItem>
            <IonRadioGroup value="m">
              <IonItem>
                <IonRadio value="m" justify="space-between">
                  Metres
                </IonRadio>
              </IonItem>
              <IonItem>
                <IonRadio value="ft" justify="space-between">
                  Feet
                </IonRadio>
              </IonItem>
            </IonRadioGroup>
            <IonItem>
              <IonRange label="Wind" min={0} max={40} value={18} pin />
            </IonItem>
            <IonItem>
              <IonLabel>One-time code</IonLabel>
            </IonItem>
            <div className="ion-padding">
              <IonInputOtp length={6} type="number" />
            </div>
            <IonItem>
              <IonTextarea label="Note" autoGrow placeholder="Briefing at 10:00" />
            </IonItem>
          </IonList>
        </div>

        <div className="kit-block">
          <h2>Accordion and card</h2>
          <IonAccordionGroup>
            <IonAccordion value="a">
              <IonItem slot="header">
                <IonIcon icon={checkmarkCircle} color="success" slot="start" />
                <IonLabel>Day quality</IonLabel>
              </IonItem>
              <div className="ion-padding" slot="content">
                LV × DV × TV = 1.00
              </div>
            </IonAccordion>
            <IonAccordion value="b">
              <IonItem slot="header">
                <IonIcon icon={warningOutline} color="warning" slot="start" />
                <IonLabel>Track quality</IonLabel>
              </IonItem>
              <div className="ion-padding" slot="content">
                Three soft checks annotate; two hard checks withhold.
              </div>
            </IonAccordion>
          </IonAccordionGroup>
          <IonCard>
            <IonCardHeader>
              <IonCardTitle>Task 2 — Open</IonCardTitle>
            </IonCardHeader>
            <IonCardContent>96.1 km · SSS 14:30 · Goal 23:00</IonCardContent>
          </IonCard>
        </div>
        <IonNote className="ion-padding">
          Not shown here but used on other screens: searchbar, FAB, sliding
          items, reorder, refresher, modal sheet, datetime, OTP boxes.
        </IonNote>
        <div style={{ height: 24 }} />
      </IonContent>
    </IonPage>
  );
};

export default KitGalleryPage;
