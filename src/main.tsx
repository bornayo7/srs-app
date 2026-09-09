import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ensurePresets } from './db/db';
import { initClock, now } from './services/clock';
import { backfillGatingOnce } from './services/gating';

/**
 * Shown instead of a blank page when the database can't be opened — another
 * tab holding a newer schema, private browsing with storage blocked, a full
 * disk. Nothing has been written at this point, so a reload is always safe.
 */
function BootFailure({ error }: { error: unknown }) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <div className="text-4xl">⚠️</div>
      <h1 className="mt-2 text-lg font-semibold text-slate-100">
        The app couldn't open its database
      </h1>
      <p className="mt-2 text-sm text-slate-400">
        Startup could not finish. This can mean another tab is using an incompatible version,
        private browsing is blocking storage, or the browser is out of space. Close other tabs of
        this app and reload.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-left text-xs text-rose-300">
        {message}
      </pre>
      <button
        className="mt-4 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
        onClick={() => location.reload()}
      >
        Reload
      </button>
    </div>
  );
}

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  try {
    await ensurePresets();
    await initClock();
    await backfillGatingOnce(now());
  } catch (err) {
    console.error('boot failed', err);
    root.render(<BootFailure error={err} />);
    return;
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
