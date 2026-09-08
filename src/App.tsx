import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { BridgeProvider } from './context/BridgeContext';
import DashboardLayout from './layouts/DashboardLayout';
import DashboardPage from './pages/DashboardPage';
import OffloadPage from './pages/OffloadPage';
import PlayerPage from './pages/PlayerPage';
import SettingsPage from './pages/SettingsPage';
import TrimmerPage from './pages/TrimmerPage';

export default function App() {
  return (
    <BridgeProvider>
      <HashRouter>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/player" element={<PlayerPage />} />
            <Route path="/trimmer" element={<TrimmerPage />} />
            <Route path="/offload" element={<OffloadPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </HashRouter>
    </BridgeProvider>
  );
}
