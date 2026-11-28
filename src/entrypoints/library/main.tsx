import React from 'react';
import ReactDOM from 'react-dom/client';
import { i18n, initI18n } from '@/i18n/index.ts';
import { initTheme } from '@/theme/index.ts';
import '@/styles/globals.css';
import App from './App';

void Promise.all([initI18n(), initTheme()]).finally(() => {
  document.title = i18n.t('library.pageTitle');
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
