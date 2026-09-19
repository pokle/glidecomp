import { Navigate, Route } from "react-router-dom";
import {
  IonIcon,
  IonLabel,
  IonRouterOutlet,
  IonTabBar,
  IonTabButton,
  IonTabs,
} from "@ionic/react";
import {
  cloudUploadOutline,
  personCircleOutline,
  paperPlaneOutline,
  trophyOutline,
} from "ionicons/icons";
import CompetitionsPage from "@/pages/CompetitionsPage";
import CompHubPage from "@/pages/CompHubPage";
import TaskPage from "@/pages/TaskPage";
import ScoresPage from "@/pages/ScoresPage";
import ReportCardPage from "@/pages/ReportCardPage";
import WaypointsPage from "@/pages/WaypointsPage";
import SubmitPage from "@/pages/SubmitPage";
import FlightsPage from "@/pages/FlightsPage";
import AccountPage from "@/pages/AccountPage";
import SettingsPage from "@/pages/SettingsPage";
import AnalysisPage from "@/pages/AnalysisPage";
import AnalysisSectionPage from "@/pages/AnalysisSectionPage";
import PilotsPage from "@/pages/PilotsPage";
import CompSettingsPage from "@/pages/CompSettingsPage";
import RouteEditorPage from "@/pages/RouteEditorPage";
import KitGalleryPage from "@/pages/KitGalleryPage";
import TaskWeatherPage from "@/pages/TaskWeatherPage";

const Tabs: React.FC = () => (
  <IonTabs>
    <IonRouterOutlet>
      <Route path="comps" element={<CompetitionsPage />} />
      <Route path="comps/:compId" element={<CompHubPage />} />
      <Route path="comps/:compId/settings" element={<CompSettingsPage />} />
      <Route path="comps/:compId/scores" element={<ScoresPage />} />
      <Route path="comps/:compId/waypoints" element={<WaypointsPage />} />
      <Route path="comps/:compId/pilots" element={<PilotsPage />} />
      <Route path="comps/:compId/analysis" element={<AnalysisPage />} />
      <Route path="comps/:compId/analysis/:section" element={<AnalysisSectionPage />} />
      <Route path="comps/:compId/task/:taskId" element={<TaskPage />} />
      <Route path="comps/:compId/task/:taskId/route" element={<RouteEditorPage />} />
      <Route path="comps/:compId/task/:taskId/weather" element={<TaskWeatherPage />} />
      <Route path="comps/:compId/task/:taskId/pilot/:pilotId" element={<ReportCardPage />} />
      <Route path="flights" element={<FlightsPage />} />
      <Route path="submit" element={<SubmitPage />} />
      <Route path="me" element={<AccountPage />} />
      <Route path="me/settings" element={<SettingsPage />} />
      <Route path="me/kit" element={<KitGalleryPage />} />
      <Route path="" element={<Navigate to="comps" replace />} />
    </IonRouterOutlet>
    <IonTabBar slot="bottom">
      <IonTabButton tab="comps" href="/tabs/comps">
        <IonIcon icon={trophyOutline} />
        <IonLabel>Comps</IonLabel>
      </IonTabButton>
      <IonTabButton tab="flights" href="/tabs/flights">
        <IonIcon icon={paperPlaneOutline} />
        <IonLabel>Flights</IonLabel>
      </IonTabButton>
      <IonTabButton tab="submit" href="/tabs/submit">
        <IonIcon icon={cloudUploadOutline} />
        <IonLabel>Submit</IonLabel>
      </IonTabButton>
      <IonTabButton tab="me" href="/tabs/me">
        <IonIcon icon={personCircleOutline} />
        <IonLabel>Me</IonLabel>
      </IonTabButton>
    </IonTabBar>
  </IonTabs>
);

export default Tabs;
