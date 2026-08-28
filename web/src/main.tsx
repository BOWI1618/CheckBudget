import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';
import './styles/global.css';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: регистрация после загрузки, чтобы не конкурировать за сеть
// с первичной отрисовкой.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Отсутствие SW не ломает приложение — теряется только офлайн-оболочка.
    });
  });
}
