import { Outlet } from 'react-router-dom';
import ErrorBoundary from '../components/ErrorBoundary';
import Sidebar from '../components/Sidebar';
import TitleBar from '../components/TitleBar';

/**
 * The shell: a 38px title bar over a fixed 206px rail beside a single scrolling
 * pane. The window itself never scrolls — only the content column does, so the
 * rail and the title bar stay put.
 *
 * There is no top bar. Search, filters and the gallery/list switch belong to
 * the screen that owns them (Videos), not to chrome that follows you around.
 */
export default function DashboardLayout() {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-ink text-paper">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {/* A screen that throws should not take the rail with it — the
              operator can still navigate somewhere that works. */}
          <ErrorBoundary label="This screen">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
