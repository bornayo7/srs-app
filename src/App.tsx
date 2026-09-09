import { Component, Suspense, lazy, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router';
import { Button } from '@/components/ui';
import { useTheme } from '@/hooks/useTheme';
import { useScheduledReleases } from '@/hooks/useScheduledReleases';
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const CoursePage = lazy(() => import('@/pages/CoursePage'));
const LessonPage = lazy(() => import('@/pages/LessonPage'));
const ReviewPage = lazy(() => import('@/pages/ReviewPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const InboxPage = lazy(() => import('@/pages/InboxPage'));
const CramPage = lazy(() => import('@/pages/CramPage'));
const StatsPage = lazy(() => import('@/pages/StatsPage'));
const PlanPage = lazy(() => import('@/pages/PlanPage'));

/** A mistyped or stale URL used to render an empty main area with no way back. */
function NotFound() {
  return (
    <div className="py-16 text-center">
      <div className="text-4xl">🧭</div>
      <p className="mt-2 text-slate-300">There's nothing at this address.</p>
      <Link to="/" className="mt-4 inline-block text-sm text-violet-300 hover:underline">
        Back to the dashboard
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

class PageRecovery extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page failed', error, info.componentStack);
  }
  render() {
    if (this.state.failed)
      return (
        <div role="alert" className="mx-auto max-w-lg py-16 text-center">
          <h1 className="text-xl font-semibold">This page could not load</h1>
          <p className="mt-2 text-slate-400">
            Your saved study data is still in this browser. Reload to try again, or return to Today.
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <Button onClick={() => location.reload()}>Reload</Button>
            <a href="/" className="p-2 text-violet-300">
              Back to Today
            </a>
          </div>
        </div>
      );
    return this.props.children;
  }
}

function AppShell() {
  const { pathname } = useLocation();
  const { theme, toggleTheme } = useTheme();
  const releaseError = useScheduledReleases();
  const studying = /^\/(review|lessons|cram)\//.test(pathname);
  return (
    <div className="min-h-screen">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <nav className="border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 font-bold text-slate-100">
            <img src="/icon.svg" alt="" className="h-6 w-6 rounded" />
            SRS
          </NavLink>
          <span className="grow" />
          <Button
            variant="ghost"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </Button>
          <div
            className="flex w-full items-center gap-5 overflow-x-auto sm:w-auto"
            aria-label="Main navigation"
          >
            <NavLink
              to="/"
              className={({ isActive }) =>
                `text-sm ${isActive ? 'text-violet-300' : 'text-slate-400 hover:text-slate-200'}`
              }
            >
              Today
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
        </div>
      </nav>
      <main
        id="main-content"
        tabIndex={-1}
        className={`mx-auto ${studying ? 'max-w-3xl' : 'max-w-6xl'} px-4 py-6 sm:py-8`}
      >
        {releaseError && (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-amber-900 bg-amber-950/50 p-3 text-sm text-amber-300"
          >
            {releaseError}
          </p>
        )}
        <PageRecovery key={pathname}>
          <Suspense
            fallback={
              <p role="status" className="py-12 text-slate-400">
                Opening page…
              </p>
            }
          >
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/course/:courseId" element={<CoursePage />} />
              <Route path="/plan/:courseId" element={<PlanPage />} />
              <Route path="/lessons/:courseId" element={<LessonPage />} />
              <Route path="/review/:courseId" element={<ReviewPage />} />
              <Route path="/cram/:courseId" element={<CramPage />} />
              <Route path="/stats" element={<StatsPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </PageRecovery>
      </main>
    </div>
  );
}
