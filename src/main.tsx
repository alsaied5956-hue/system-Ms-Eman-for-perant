import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Register Service Worker and capture PWA installation prompt immediately
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    (window as any).__pwaDeferredPrompt = e;
  });

  if ('serviceWorker' in navigator) {
    const registerSW = async () => {
      try {
        // Clean up legacy or duplicate service workers
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          const scriptUrl = reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
          if (scriptUrl && !scriptUrl.endsWith('/sw.js')) {
            console.log('[SW] Unregistering legacy worker:', scriptUrl);
            await reg.unregister();
          }
        }

        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        if (registration) {
          registration.update().catch(() => {});
        }

        // Detect newly activated service worker and ensure clean sync
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          console.log('[SW] Controller changed. Clean sync active against live Supabase.');
          window.dispatchEvent(new CustomEvent('sw-controller-updated'));
        });
      } catch (err) {
        console.warn('Service Worker registration skipped or failed:', err);
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      registerSW();
    } else {
      window.addEventListener('DOMContentLoaded', registerSW);
    }
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
