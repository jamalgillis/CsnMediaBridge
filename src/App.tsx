import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { BridgeProvider } from './context/BridgeContext';
import DashboardLayout from './layouts/DashboardLayout';
import DashboardPage from './pages/DashboardPage';
import PlayerPage from './pages/PlayerPage';
import SettingsPage from './pages/SettingsPage';
import TrimmerPage from './pages/TrimmerPage';

export default function App() {
  return (
    <ThemeProvider>
      <BridgeProvider>
        <HashRouter>
          <Routes>
            <Route path="/dashboard" element={<DashboardLayout />}>
              <Route index element={<DashboardPage />} />
            </Route>
            <Route path="/player" element={<DashboardLayout />}>
              <Route index element={<PlayerPage />} />
            </Route>
            <Route path="/trimmer" element={<DashboardLayout />}>
              <Route index element={<TrimmerPage />} />
            </Route>
            <Route path="/settings" element={<DashboardLayout />}>
              <Route index element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </HashRouter>
      </BridgeProvider>
    </ThemeProvider>
  );
}
