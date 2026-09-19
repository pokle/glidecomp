import { Navigate, Route } from "react-router-dom";
import { IonApp, IonRouterOutlet, setupIonicReact } from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";
import Tabs from "@/pages/Tabs";
import SignInPage from "@/pages/SignInPage";

setupIonicReact({ mode: "ios" });

export default function App() {
  return (
    <IonApp>
      <IonReactRouter>
        <IonRouterOutlet>
          <Route path="/tabs/*" element={<Tabs />} />
          <Route path="/signin" element={<SignInPage />} />
          <Route path="/" element={<Navigate to="/tabs/comps" replace />} />
        </IonRouterOutlet>
      </IonReactRouter>
    </IonApp>
  );
}
