import type { ReactNode } from "react";
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { chevronBackOutline } from "ionicons/icons";
import { TURNPOINTS } from "@/data/mock";
import { usePrefs } from "@/state/prefs";

/** Explicit back link. IonBackButton is unreliable with nested tab routes. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <IonButtons slot="start">
      <IonButton routerLink={href} routerDirection="back">
        <IonIcon slot="start" icon={chevronBackOutline} />
        {children}
      </IonButton>
    </IonButtons>
  );
}

export function Page({
  title,
  backHref,
  buttons,
  children,
  fullscreen = true,
}: {
  title: string;
  backHref?: string;
  buttons?: ReactNode;
  children: ReactNode;
  fullscreen?: boolean;
}) {
  return (
    <IonPage>
      <IonHeader translucent>
        <IonToolbar>
          {backHref ? <BackLink href={backHref}>Back</BackLink> : null}
          <IonTitle>{title}</IonTitle>
          {buttons}
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen={fullscreen}>
        {fullscreen ? (
          <IonHeader collapse="condense">
            <IonToolbar>
              <IonTitle size="large">{title}</IonTitle>
            </IonToolbar>
          </IonHeader>
        ) : null}
        {children}
      </IonContent>
    </IonPage>
  );
}

export function MapPlaceholder({
  caption,
  height = 220,
}: {
  caption: string;
  height?: number;
}) {
  const path = "M 40 150 C 80 140, 90 90, 140 100 S 200 40, 250 70 S 310 160, 360 90";
  return (
    <div className="hero-map" style={{ height }} role="img" aria-label={caption}>
      <svg viewBox="0 0 390 220" preserveAspectRatio="xMidYMid slice">
        <path
          d={path}
          fill="none"
          stroke="var(--gc-primary)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {TURNPOINTS.filter((tp) => tp.role !== "GOAL").map((tp, i) => {
          const x = 40 + i * 48;
          const y = 70 + (i % 3) * 28;
          return (
            <g key={`${tp.role}-${i}`}>
              <circle cx={x} cy={y} r="7" fill="var(--gc-card)" stroke="var(--gc-primary)" />
              <text x={x} y={y - 12} textAnchor="middle" fontSize="9" fill="var(--gc-foreground)">
                {tp.code}
              </text>
            </g>
          );
        })}
      </svg>
      <div
        style={{
          position: "absolute",
          left: 12,
          bottom: 10,
          fontSize: 12,
          color: "#fff",
          textShadow: "0 1px 2px rgba(0,0,0,.6)",
        }}
      >
        {caption}
      </div>
    </div>
  );
}

export function Podium({
  rows,
}: {
  rows: { name: string; points: number; id: string }[];
}) {
  const order = [rows[1], rows[0], rows[2]];
  const ranks = [2, 1, 3];
  return (
    <div className="podium" aria-label="Top 3">
      {order.map((row, i) =>
        row ? (
          <div
            key={row.id}
            className={`podium-slot ${ranks[i] === 1 ? "first" : ""}`}
          >
            <div className="podium-rank">{ranks[i]}</div>
            <div className="podium-name">{row.name.split(" ").slice(-1)[0]}</div>
            <div className="podium-pts">{row.points}</div>
          </div>
        ) : null
      )}
    </div>
  );
}

export function DistanceChart() {
  // Emphasis chart: one accent pilot, muted field. Sampled curve, not a fit.
  const field: [number, number][] = [
    [8, 90],
    [22, 78],
    [36, 70],
    [48, 58],
    [62, 44],
    [74, 36],
    [88, 28],
    [96, 18],
  ];
  const you: [number, number] = [96, 18];
  return (
    <div className="chart-frame">
      <svg viewBox="0 0 320 140" role="img" aria-label="Distance points against flown distance">
        <text x="8" y="14" fontSize="11" fill="var(--gc-muted-foreground)">
          Distance points
        </text>
        <path
          d="M 20 110 C 80 108, 140 90, 200 50 S 290 18, 300 16"
          fill="none"
          stroke="var(--gc-primary)"
          strokeWidth="2"
        />
        {field.map(([x, y], i) => (
          <circle key={i} className="muted-dot" cx={20 + x * 2.8} cy={y} r="3.5" />
        ))}
        <circle className="accent-dot" cx={20 + you[0] * 2.8} cy={you[1]} r="6" />
      </svg>
      <p className="chart-caption">
        The curve is the GAP distance formula. Your result is the filled dot;
        everyone else is muted.
      </p>
    </div>
  );
}

export function CleaningChart() {
  return (
    <div className="chart-frame">
      <svg viewBox="0 0 320 140" role="img" aria-label="Track data cleaning">
        <polyline
          points="10,40 50,48 90,30 130,90 170,44 210,50 250,42 310,46"
          fill="none"
          stroke="#ff9500"
          strokeWidth="1.5"
          strokeDasharray="3 3"
        />
        <polyline
          points="10,70 50,66 90,72 130,68 170,74 210,70 250,69 310,71"
          fill="none"
          stroke="#af52de"
          strokeWidth="1.5"
          strokeDasharray="2 4"
        />
        <polyline
          points="10,52 50,54 90,50 130,56 170,53 210,55 250,52 310,54"
          fill="none"
          stroke="var(--gc-primary)"
          strokeWidth="2.5"
        />
      </svg>
      <p className="chart-caption">
        Orange dashed: raw GPS. Purple dashed: raw barometer. Blue: the cleaned
        altitude the analysis used.
      </p>
    </div>
  );
}

export function RoleOnly({
  organiser,
  children,
}: {
  organiser?: boolean;
  children: ReactNode;
}) {
  const { role } = usePrefs();
  if (organiser && role !== "organiser") return null;
  return <>{children}</>;
}
