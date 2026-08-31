import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ensurePresets } from './db/db';
import { initClock, now } from './services/clock';
import { backfillGatingOnce } from './services/gating';

async function boot() {
  await ensurePresets();
  await initClock();
  await backfillGatingOnce(now());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
