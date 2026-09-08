import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { PersistenceGate } from './components/PersistenceGate';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistenceGate>{data => <App initialData={data} />}</PersistenceGate>
  </StrictMode>,
);
