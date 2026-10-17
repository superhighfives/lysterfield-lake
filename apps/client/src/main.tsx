import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './routes/root.tsx'
import './index.css'

// The /admin dream review page only exists in dev: the DEV check is
// replaced with `false` in production builds, so the lazy import (and the
// page's code) is dropped from the bundle.
// /admin/record is the webcam recorder for the polaroid prototype.
const Admin = import.meta.env.DEV
  ? lazy(() => (location.pathname.startsWith('/admin/record') ? import('./views/admin-record.tsx') : import('./views/admin.tsx')))
  : null
const showAdmin = Admin !== null && location.pathname.startsWith('/admin')

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {showAdmin && Admin ? (
      <Suspense fallback={null}>
        <Admin />
      </Suspense>
    ) : (
      <Root />
    )}
  </StrictMode>
)
