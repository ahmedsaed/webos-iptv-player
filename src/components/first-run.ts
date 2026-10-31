import type { PlaylistEntry } from '../types';
import type { ServiceInfo } from '../services/setup-client';
import { html, raw, type Safe } from '../utils/dom';
import { t } from '../i18n';
import { CONFIG } from '../config';
import { qrDataUrl } from './setup-qr';
import { PHONE_ICON } from './icons';

export type FirstRunLanding = 'home' | 'settings';

// No source at all: a launch onto Home shows the first-run screen there;
// a later channel load opens Settings.
export function firstRunLanding(
  playlists: readonly PlaylistEntry[],
  landing: 'launch' | 'live' | 'quiet',
): FirstRunLanding | null {
  if (playlists.length) return null;
  return landing === 'launch' ? 'home' : 'settings';
}

// Home's intro and the phone-setup panel beside its two Add cards. `info`
// is undefined while the setup service is still being asked.
export function firstRunIntro(): Safe {
  return html`
    <div class="home-welcome">
      <div class="home-welcome-title">${t('home.welcomeTitle', { name: CONFIG.APP_NAME })}</div>
      <div class="home-welcome-hint">${t('home.welcomeHint')}</div>
    </div>
  `;
}

export function phoneSetupPanel(info: ServiceInfo | null | undefined): Safe {
  return html`
    <section class="home-setup" data-key="setup">
      <div class="home-setup-title">
        <span class="home-setup-icon">${raw(PHONE_ICON)}</span>
        <span class="home-setup-title-text">${t('settings.deviceSetup')}</span>
      </div>
      ${info ? html`
        <div class="home-setup-hint">${t('settings.setupScanQr')}</div>
        <div class="home-setup-body">
          <img class="setup-qr home-setup-qr" alt="${t('settings.qrAlt', { url: info.setupUrl })}"
               src="${qrDataUrl(info.setupUrl)}">
          <div class="home-setup-steps">
            <div class="home-setup-step">${t('settings.setupOpenInBrowser')}</div>
            <div class="home-setup-url">${info.manualUrl}</div>
            <div class="home-setup-step home-setup-step-code">${t('settings.setupPairingPrompt')}</div>
            <div class="home-setup-code">${info.pairingCode}</div>
          </div>
        </div>
      ` : html`
        <div class="home-setup-hint">${t(info === null ? 'settings.setupUnavailable' : 'settings.checkingSetup')}</div>
      `}
    </section>
  `;
}
