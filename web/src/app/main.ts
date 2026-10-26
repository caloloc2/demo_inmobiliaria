import '../style.css';

const status = document.getElementById('status')!;
status.textContent = `PWA lista · ${'serviceWorker' in navigator ? 'Service Worker OK' : 'sin Service Worker'}`;
