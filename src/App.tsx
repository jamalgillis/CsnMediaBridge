import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { BridgeProvider } from './context/BridgeContext';
import { AuthProvider, useAuth } from './auth/AuthContext';
import SignInScreen from './auth/SignInScreen';
import DashboardLayout from './layouts/DashboardLayout';
import DashboardPage from './pages/DashboardPage';
import LiveStreamsPage from './pages/LiveStreamsPage';
import OffloadPage from './pages/OffloadPage';
import PlayerPage from './pages/PlayerPage';
import SettingsPage from './pages/SettingsPage';
import TrimmerPage from './pages/TrimmerPage';

/**
 * The gate sits around the window, not around the pipeline.
 *
 * Ingest runs in the Rust host and never consults this tree, so a station left
 * at the sign-in screen still watches its folder, converts, uploads and
 * registers. What sign-in governs is what a person sitting at the machine can
 * see and change.
 *
 * A build with no Clerk instance renders straight through, so stations that
 * have not been migrated keep working exactly as before.
 */
function Gate() {
  const { status } = useAuth();

  // `checking` renders nothing rather than flashing the gate at a station that
  // is in fact signed in.
  if (status === 'checking') {
    return <div className="h-screen w-screen bg-ink" />;
  }

  if (status === 'signed-out') {
    return <SignInScreen />;
  }

  return (
    <HashRouter>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/live" element={<LiveStreamsPage />} />
          <Route path="/player" element={<PlayerPage />} />
          <Route path="/trimmer" element={<TrimmerPage />} />
          <Route path="/offload" element={<OffloadPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </HashRouter>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BridgeProvider>
        <Gate />
      </BridgeProvider>
    </AuthProvider>
  );
}
