import { useRef, useState } from "react";
import {
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonList,
  IonNote,
  IonPage,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToolbar,
  useIonToast,
} from "@ionic/react";
import { cloudUploadOutline, documentOutline } from "ionicons/icons";
import { COMPS, TASKS } from "@/data/mock";
import { usePrefs } from "@/state/prefs";

const SubmitPage: React.FC = () => {
  const { signedIn, setSignedIn } = usePrefs();
  const [compId, setCompId] = useState("corryong");
  const [taskId, setTaskId] = useState("t2");
  const [who, setWho] = useState("self");
  const [fileName, setFileName] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [toast] = useIonToast();
  const tasks = TASKS.filter((t) => t.compId === compId);

  function acceptFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".igc")) {
      void toast({ message: "That is not an IGC file.", color: "danger", duration: 1800 });
      return;
    }
    setFileName(file.name);
  }

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonTitle>Submit track</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonHeader collapse="condense">
          <IonToolbar>
            <IonTitle size="large">Submit track</IonTitle>
          </IonToolbar>
        </IonHeader>
        <p className="ion-padding" style={{ paddingBottom: 0 }}>
          The registered pilot is emailed on every submission. This POC only
          pretends to send.
        </p>

        <div
          className={`drop-zone${over ? " over" : ""}`}
          style={{ margin: 16 }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            acceptFile(e.dataTransfer.files[0]);
          }}
        >
          <IonIcon icon={fileName ? documentOutline : cloudUploadOutline} size="large" />
          <p>{fileName ?? "Drop an IGC, or pick a file"}</p>
          <IonButton fill="outline" onClick={() => inputRef.current?.click()}>
            Choose file
          </IonButton>
          <input
            ref={inputRef}
            type="file"
            accept=".igc,application/octet-stream"
            hidden
            onChange={(e) => acceptFile(e.target.files?.[0])}
          />
        </div>

        <IonList inset>
          <IonItem>
            <IonSelect
              label="Competition"
              interface="action-sheet"
              value={compId}
              onIonChange={(e) => {
                setCompId(String(e.detail.value));
                const next = TASKS.find((t) => t.compId === e.detail.value);
                if (next) setTaskId(next.id);
              }}
            >
              {COMPS.filter((c) => !c.test).map((c) => (
                <IonSelectOption key={c.id} value={c.id}>
                  {c.name}
                </IonSelectOption>
              ))}
            </IonSelect>
          </IonItem>
          <IonItem>
            <IonSelect
              label="Task"
              interface="action-sheet"
              value={taskId}
              onIonChange={(e) => setTaskId(String(e.detail.value))}
            >
              {tasks.map((t) => (
                <IonSelectOption key={t.id} value={t.id}>
                  {t.name}
                </IonSelectOption>
              ))}
            </IonSelect>
          </IonItem>
          <IonItem>
            <IonSelect
              label="Submitting as"
              interface="action-sheet"
              value={who}
              onIonChange={(e) => setWho(String(e.detail.value))}
            >
              <IonSelectOption value="self">Jon Durand (you)</IonSelectOption>
              <IonSelectOption value="holtkamp">Rohan Holtkamp</IonSelectOption>
              <IonSelectOption value="new">Someone not on the roster</IonSelectOption>
            </IonSelect>
          </IonItem>
          {!signedIn ? (
            <IonItem>
              <IonInput label="Your name" placeholder="As on the roster" />
            </IonItem>
          ) : null}
          <IonItem>
            <IonTextarea
              label="Note for the scorer"
              autoGrow
              value={notes}
              onIonInput={(e) => setNotes(e.detail.value ?? "")}
            />
          </IonItem>
        </IonList>
        {who !== "self" ? (
          <p className="muted" style={{ padding: "0 20px" }}>
            Submitting for someone else still emails the registered pilot.
          </p>
        ) : null}

        <div className="ion-padding">
          <IonButton
            expand="block"
            disabled={!fileName}
            onClick={() =>
              void toast({
                message: fileName
                  ? `Accepted ${fileName} for ${tasks.find((t) => t.id === taskId)?.name}.`
                  : "Pick a file first.",
                color: "success",
                duration: 2200,
              })
            }
          >
            Submit track
          </IonButton>
          {!signedIn ? (
            <IonButton expand="block" fill="clear" routerLink="/signin">
              Sign in instead
            </IonButton>
          ) : (
            <IonButton expand="block" fill="clear" onClick={() => setSignedIn(false)}>
              Preview the anonymous form
            </IonButton>
          )}
        </div>
        <IonNote className="ion-padding">Step 1 of 3 is the file. Comp and task stay visible even when prefilled, so you cannot file against yesterday by accident.</IonNote>
      </IonContent>
    </IonPage>
  );
};

export default SubmitPage;
