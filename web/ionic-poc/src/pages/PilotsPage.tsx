import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  IonBadge,
  IonContent,
  IonFab,
  IonFabButton,
  IonHeader,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  useIonAlert,
  useIonToast,
} from "@ionic/react";
import { BackLink } from "@/components/ui";
import { addOutline } from "ionicons/icons";
import { PILOTS } from "@/data/mock";

const PilotsPage: React.FC = () => {
  const { compId } = useParams<{ compId: string }>();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState(PILOTS);
  const [alert] = useIonAlert();
  const [toast] = useIonToast();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <BackLink href={`/tabs/comps/${compId}`}>Comp</BackLink>
          <IonTitle>Pilots</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonSearchbar
          value={query}
          debounce={0}
          placeholder="Find a pilot"
          onIonInput={(e) => setQuery(e.detail.value ?? "")}
        />
        <p className="muted" style={{ padding: "0 16px" }}>
          The desktop roster is a Tabulator grid. On a phone that is a sideways
          scroll. Here each pilot is a row; swipe for status, tap to edit.
        </p>
        <IonList inset>
          {filtered.map((p) => (
            <IonItemSliding key={p.id}>
              <IonItem>
                <IonLabel>
                  <h2>
                    {p.name}{" "}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {p.nation}
                    </span>
                  </h2>
                  <p>CIVL {p.civl}</p>
                </IonLabel>
                <IonBadge slot="end" color={p.klass === "Open" ? "primary" : "medium"}>
                  {p.klass}
                </IonBadge>
                <IonNote slot="end">{p.status}</IonNote>
              </IonItem>
              <IonItemOptions side="end">
                <IonItemOption
                  onClick={() =>
                    void toast({ message: `${p.name} marked landed out.`, duration: 1400 })
                  }
                >
                  DNF
                </IonItemOption>
                <IonItemOption
                  color="warning"
                  onClick={() =>
                    void toast({ message: `${p.name} marked absent.`, duration: 1400 })
                  }
                >
                  Absent
                </IonItemOption>
                <IonItemOption
                  color="danger"
                  onClick={() =>
                    void alert({
                      header: `Remove ${p.name}?`,
                      message: "They leave the roster. Tracks already scored stay in the audit log.",
                      buttons: [
                        { text: "Cancel", role: "cancel" },
                        {
                          text: "Remove",
                          role: "destructive",
                          handler: () => setRows((prev) => prev.filter((x) => x.id !== p.id)),
                        },
                      ],
                    })
                  }
                >
                  Remove
                </IonItemOption>
              </IonItemOptions>
            </IonItemSliding>
          ))}
        </IonList>
        <IonList inset>
          <IonItem>
            <IonSelect label="Default class" interface="popover" value="Open">
              <IonSelectOption value="Open">Open</IonSelectOption>
              <IonSelectOption value="Floater">Floater</IonSelectOption>
            </IonSelect>
          </IonItem>
        </IonList>
        <IonFab slot="fixed" vertical="bottom" horizontal="end">
          <IonFabButton
            onClick={() => void toast({ message: "Add-pilot sheet would open.", duration: 1400 })}
            aria-label="Add pilot"
          >
            <IonIcon icon={addOutline} />
          </IonFabButton>
        </IonFab>
      </IonContent>
    </IonPage>
  );
};

export default PilotsPage;
