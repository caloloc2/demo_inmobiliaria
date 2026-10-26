import '../style.css';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

type Platform = 'ios' | 'android' | 'desktop';

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS 13+ se identifica como Mac pero tiene pantalla táctil.
  const isIpadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || isIpadOs) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

const platform = detectPlatform();
document.getElementById(platform)?.classList.remove('hidden');
const urlEl = document.getElementById('url');
if (urlEl) urlEl.textContent = location.host;

// Ya instalada: ir directo a la app.
const standalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
if (standalone) location.replace('/app/');

// Android/Chrome: botón de instalación nativo.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let deferred: BeforeInstallPromptEvent | null = null;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BeforeInstallPromptEvent;
  installBtn?.classList.remove('hidden');
  document.getElementById('android-steps')?.classList.add('hidden');
});

installBtn?.addEventListener('click', async () => {
  if (!deferred) return;
  await deferred.prompt();
  await deferred.userChoice;
  deferred = null;
  installBtn.classList.add('hidden');
});
