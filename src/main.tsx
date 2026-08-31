import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ensurePresets } from './db/db';
import { initClock } from './services/clock';

async function boot() {
  await ensurePresets();
  await initClock();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
