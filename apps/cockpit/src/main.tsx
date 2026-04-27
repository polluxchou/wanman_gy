import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { queryClient } from './lib/query-client.js';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
