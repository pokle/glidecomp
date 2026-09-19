import { useMemo, useState } from "react";
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonChip,
  IonContent,
  IonFab,
  IonFabButton,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  useIonToast,
} from "@ionic/react";
import { addOutline, trophyOutline } from "ionicons/icons";
import {
  COMPS,
  categoryLabel,
  formatDateRange,
  scoringLabel,
  type Category,
} from "@/data/mock";
import { usePrefs } from "@/state/prefs";

const CompetitionsPage: React.FC = () => {
  const { role, signedIn } = usePrefs();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | Category>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("Spring Cup");
  const [toast] = useIonToast();

  const comps = useMemo(() => {
    const q = query.trim().toLowerCase();
    return COMPS.filter((c) => {
      if (c.test && role !== "organiser") return false;
      if (filter !== "all" && c.category !== filter) return false;
      if (!q) return true;
      return `${c.name} ${c.place} ${c.classes.join(" ")}`.toLowerCase().includes(q);
    });
  }, [query, filter, role]);

  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          <IonTitle>Competitions</IonTitle>
          {signedIn && role === "organiser" ? (
            <IonButtons slot="end">
              <IonButton onClick={() => setCreateOpen(true)}>New</IonButton>
            </IonButtons>
          ) : null}
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonHeader collapse="condense">
          <IonToolbar>
            <IonTitle size="large">Competitions</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonRefresher
          slot="fixed"
          onIonRefresh={(e) => {
            setTimeout(() => {
              e.detail.complete();
              void toast({ message: "List is mocked — nothing new to fetch.", duration: 1600 });
            }, 700);
          }}
        >
          <IonRefresherContent />
        </IonRefresher>

        <IonSearchbar
          value={query}
          onIonInput={(e) => setQuery(e.detail.value ?? "")}
          placeholder="Search comps, tasks, pilots…"
          debounce={0}
        />

        <div style={{ padding: "0 12px 8px", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["all", "hg", "pg"] as const).map((key) => (
            <IonChip
              key={key}
              outline={filter !== key}
              color={filter === key ? "primary" : undefined}
              onClick={() => setFilter(key)}
            >
              {key === "all" ? "All" : key === "hg" ? "Hang gliding" : "Paragliding"}
            </IonChip>
          ))}
        </div>

        <IonList inset>
          {comps.map((comp) => (
            <IonItem
              key={comp.id}
              routerLink={`/tabs/comps/${comp.id}`}
              detail
              className="gc-row"
            >
              <IonIcon icon={trophyOutline} slot="start" color="primary" />
              <IonLabel>
                <h2>
                  {comp.name}{" "}
                  {comp.test ? (
                    <IonBadge color="medium" style={{ verticalAlign: "middle" }}>
                      Hidden
                    </IonBadge>
                  ) : null}
                </h2>
                <p>
                  {categoryLabel(comp.category)} · {scoringLabel(comp.scoringFormat)} ·{" "}
                  {comp.classes.join(", ")}
                </p>
              </IonLabel>
              <IonNote slot="end" className="tabular">
                {formatDateRange(comp.firstDate, comp.lastDate)}
              </IonNote>
            </IonItem>
          ))}
        </IonList>
        {comps.length === 0 ? (
          <p className="muted" style={{ padding: "24px 20px" }}>
            No competitions match “{query}”.
          </p>
        ) : null}

        {role === "organiser" ? (
          <IonFab slot="fixed" vertical="bottom" horizontal="end">
            <IonFabButton onClick={() => setCreateOpen(true)} aria-label="Start a new competition">
              <IonIcon icon={addOutline} />
            </IonFabButton>
          </IonFab>
        ) : null}

        <IonModal isOpen={createOpen} onDidDismiss={() => setCreateOpen(false)}>
          <IonHeader>
            <IonToolbar>
              <IonButtons slot="start">
                <IonButton onClick={() => setCreateOpen(false)}>Cancel</IonButton>
              </IonButtons>
              <IonTitle>New competition</IonTitle>
              <IonButtons slot="end">
                <IonButton
                  strong
                  onClick={() => {
                    setCreateOpen(false);
                    void toast({
                      message: `“${name}” would be created. This POC does not persist it.`,
                      duration: 2200,
                    });
                  }}
                >
                  Create
                </IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding">
            <IonList inset>
              <IonItem>
                <IonInput
                  label="Name"
                  value={name}
                  onIonInput={(e) => setName(e.detail.value ?? "")}
                />
              </IonItem>
              <IonItem>
                <IonSelect label="Wing" interface="action-sheet" value="hg">
                  <IonSelectOption value="hg">Hang gliding</IonSelectOption>
                  <IonSelectOption value="pg">Paragliding</IonSelectOption>
                </IonSelect>
              </IonItem>
              <IonItem>
                <IonSelect label="Scoring" interface="action-sheet" value="gap">
                  <IonSelectOption value="gap">GAP</IonSelectOption>
                  <IonSelectOption value="open_distance">Open distance</IonSelectOption>
                </IonSelect>
              </IonItem>
            </IonList>
            <p className="muted" style={{ padding: "0 20px" }}>
              The real app also asks for pilot classes and whether this is a hidden test
              competition.
            </p>
          </IonContent>
        </IonModal>
      </IonContent>
    </IonPage>
  );
};

export default CompetitionsPage;
