import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './routes/root.tsx'
import ErrorScreen from './components/error-screen.tsx'
import './index.css'

// The /admin dream review page only exists in dev: the DEV check is
// replaced with `false` in production builds, so the lazy import (and the
// page's code) is dropped from the bundle.
// /admin/record and /admin/polaroid are the polaroid prototype's recorder and viewer.
const adminPage = () => {
  if (location.pathname.startsWith('/admin/record')) return import('./views/admin-record.tsx')
  if (location.pathname.startsWith('/admin/polaroid')) return import('./views/admin-polaroid.tsx')
  return import('./views/admin.tsx')
}

const Admin = import.meta.env.DEV ? lazy(adminPage) : null
const showAdmin = Admin !== null && location.pathname.startsWith('/admin')

// Visitors' polaroids (plans/in-progress/polaroids.md): the gallery, adding one, and each one's private link, their
// own pages apart from the song. Off until VITE_APP_POLAROIDS is "true", and then the pages are left out of the build.
const polaroidPage = () => {
  if (location.pathname.startsWith('/polaroids/add')) return import('./views/polaroids/add.tsx')
  if (location.pathname.startsWith('/p/')) return import('./views/polaroids/link.tsx')
  return import('./views/polaroids/gallery.tsx')
}

const Polaroids = import.meta.env.VITE_APP_POLAROIDS === 'true' ? lazy(polaroidPage) : null
const showPolaroids = Polaroids !== null && /^\/(polaroids(\/|$)|p\/)/.test(location.pathname)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {showAdmin && Admin ? (
      <Suspense fallback={null}>
        <Admin />
      </Suspense>
    ) : showPolaroids && Polaroids ? (
      <Suspense fallback={null}>
        <Polaroids />
      </Suspense>
    ) : (
      <ErrorScreen>
        <Root />
      </ErrorScreen>
    )}
  </StrictMode>
)
