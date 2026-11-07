import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/theme.css';
import './styles/app.css';

/**
 * Renderer bootstrap.
 *
 * Styles are imported once here: `theme.css` holds tokens, base typography and
 * the motion keyframes; `app.css` holds layout and components.
 */
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);