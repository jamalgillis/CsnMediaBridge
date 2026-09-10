import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import TopBar from '../components/TopBar';

/**
 * The shell: a fixed 248px rail beside a single scrolling pane. The window
 * itself never scrolls — only the content column does, so the rail and the 64px
 * top bar (the site header's row height) stay put.
 */
export default function DashboardLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ink text-paper">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
