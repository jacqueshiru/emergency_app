import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initTokenStore } from './services/tokenStore';

// On Android the session is read from secure storage once, before the first render.
initTokenStore().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
