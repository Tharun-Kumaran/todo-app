import { useEffect, useState } from 'react';
import { MoonIcon, SunIcon } from './icons';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function Header() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (localStorage.getItem('todo-theme')) return;
      const next: Theme = media.matches ? 'dark' : 'light';
      setTheme(next);
      document.documentElement.dataset.theme = next;
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('todo-theme', next);
    } catch {
      // Storage can be unavailable in private mode; the theme still applies.
    }
  }

  return (
    <header className="header">
      <div>
        <h1>To-Do</h1>
        <p className="date">{today}</p>
      </div>
      <button
        className="icon-btn"
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </header>
  );
}
