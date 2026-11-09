// "Add your own", the link under the chooser's stack to visitors' polaroids (plans/in-progress/polaroids.md). It's
// a fixed page element in routes/root.tsx, not part of the 3D scene: drei's Html mounts inside ScrollControls'
// scroll area, where its far-off position made the page taller and the scroll never reached the stack. The scene
// (views/choose.tsx) fades it with the stack every frame through this ref, so nothing re-renders.

export const POLAROIDS = import.meta.env.VITE_APP_POLAROIDS === 'true'

export const addYoursLink: { current: HTMLAnchorElement | null } = { current: null }
