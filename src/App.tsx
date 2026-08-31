import { BrowserRouter, NavLink, Route, Routes } from 'react-router';
import Dashboard from '@/pages/Dashboard';
import CoursePage from '@/pages/CoursePage';
import LessonPage from '@/pages/LessonPage';
import ReviewPage from '@/pages/ReviewPage';
import SettingsPage from '@/pages/SettingsPage';
import InboxPage from '@/pages/InboxPage';
import CramPage from '@/pages/CramPage';
import StatsPage from '@/pages/StatsPage';

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen">
        <nav className="border-b border-slate-800 bg-slate-950/90 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3">
            <NavLink to="/" className="flex items-center gap-2 font-bold text-slate-100">
              <img src="/icon.svg" alt="" className="h-6 w-6 rounded" />
              SRS
            </NavLink>
            <div className="grow" />
            <NavLink
              to="/"
              className={({ isActive }) =>
                `text-sm ${isActive ? 'text-violet-300' : 'text-slate-400 hover:text-slate-200'}`
              }
            >
              Dashboard
            </NavLink>
            <NavLink
              to="/stats"
              className={({ isActive }) =>
                `text-sm ${isActive ? 'text-violet-300' : 'text-slate-400 hover:text-slate-200'}`
              }
            >
              Stats
            </NavLink>
            <NavLink
              to="/inbox"
              className={({ isActive }) =>
                `text-sm ${isActive ? 'text-violet-300' : 'text-slate-400 hover:text-slate-200'}`
              }
            >
              Inbox
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `text-sm ${isActive ? 'text-violet-300' : 'text-slate-400 hover:text-slate-200'}`
              }
            >
              Settings
            </NavLink>
          </div>
        </nav>
        <main className="mx-auto max-w-3xl px-4 py-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/course/:courseId" element={<CoursePage />} />
            <Route path="/lessons/:courseId" element={<LessonPage />} />
            <Route path="/review/:courseId" element={<ReviewPage />} />
            <Route path="/cram/:courseId" element={<CramPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
