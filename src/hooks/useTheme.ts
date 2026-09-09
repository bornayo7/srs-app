import { useEffect, useState } from 'react';

export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('srs-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('srs-theme', theme);
    } catch {
      /* preference still applies this visit */
    }
  }, [theme]);
  return { theme, toggleTheme: () => setTheme((value) => (value === 'dark' ? 'light' : 'dark')) };
}
