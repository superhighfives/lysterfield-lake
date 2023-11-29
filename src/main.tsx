import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './routes/root.tsx'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
