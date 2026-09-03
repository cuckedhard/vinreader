import { Navigate, Route, Routes } from "react-router";
import { Shell } from "./Shell";
import ScanScreen from "../features/scan/ScanScreen";
import SheetScreen from "../features/sheet/SheetScreen";
import HistoryScreen from "../features/history/HistoryScreen";
import SettingsScreen from "../features/settings/SettingsScreen";

/** Hash routes keep the app trivially static-hostable and keep handoff
 *  payloads out of server logs (§2, §6.2). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/scan" replace />} />
        <Route path="scan" element={<ScanScreen />} />
        <Route path="v/:vin" element={<SheetScreen />} />
        <Route path="history" element={<HistoryScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/scan" replace />} />
      </Route>
    </Routes>
  );
}
