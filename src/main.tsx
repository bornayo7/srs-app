import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ensurePresets } from './db/db';
import { initClock, now } from './services/clock';
import { backfillGatingOnce } from './services/gating';
import { syncAllScheduledReleases } from './services/plans';

async function boot() {
  await ensurePresets();
  await initClock();
  await backfillGatingOnce(now());
  // course plans released by date: raise the level floor to today's unit
  await syncAllScheduledReleases(now());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
