/**
 * Local canvas mode is an opt-in convenience for the one-click dev launcher.
 * `import.meta.env.DEV` makes the auth bypass impossible in production builds.
 */
export function isLocalCanvasMode(): boolean {
  if (!import.meta.env.DEV) return false;
  return String(import.meta.env.VITE_LOCAL_CANVAS_MODE || '')
    .trim()
    .toLowerCase() === 'true';
}

/** Local identity used only to unlock browser-side development UI. */
export const LOCAL_CANVAS_USER = {
  id: 'local-canvas-developer',
  email: 'local-canvas@localhost',
  name: '本地画布开发者',
  provider: 'email' as const,
  role: 'admin' as const,
  bio: 'Local development mode',
};

/** UI-level access; this deliberately does not pretend that a cloud token exists. */
export function hasLocalCanvasAccess(): boolean {
  return isLocalCanvasMode();
}
