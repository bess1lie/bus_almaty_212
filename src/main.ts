/**
 * main.ts — точка входа Vite.
 * Запуск bootstrapping приложения.
 */

import './app/bootstrap';

// PWA: register service worker (только в production)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
