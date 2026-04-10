import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import TopBar from '../components/TopBar';

export default function DashboardLayout() {
  return (
    <div className="min-h-screen bg-surface-light-deep text-slate-900 dark:bg-surface-deep dark:text-white">
      <Sidebar />
      <div className="min-h-screen lg:ml-20">
        <TopBar />
        <main className="mx-auto max-w-dashboard p-4 pb-24 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
