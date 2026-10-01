// Registers the service worker so the browser considers Saffron POS
// installable (desktop "Install app" / Android "Add to Home screen").
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Non-fatal -- the app still works over plain HTTP(S), it just won't
      // be installable without a registered service worker.
    });
  });
}
