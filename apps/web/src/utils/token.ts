/** Session token helpers (Bearer for API). */

const TOKEN_KEY = 'recombine-auth-token-v1';

export function getToken(): string | null {
  if (
    import.meta.env.DEV &&
    String(import.meta.env.VITE_LOCAL_CANVAS_MODE || '').trim().toLowerCase() === 'true'
  ) {
    return 'local-canvas-development';
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (!token) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}
