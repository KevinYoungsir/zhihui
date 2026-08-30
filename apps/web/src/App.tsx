import { useEffect, memo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { apiQuery, queryClient } from '@/service/client';
import { clearProjectsListCache } from '@/service/projects';
import { clearWalletCache, WALLET_ME_QUERY_OPTS } from '@/service/wallet';
import AppRouter from '@/router';
import { logout, setSession, setUser, clearSessionCaches } from '@/store/modules/auth';
import { clearProjectsLibrary } from '@/store/modules/editor';
import { isLocalCanvasMode, LOCAL_CANVAS_USER } from '@/utils/localCanvasMode';
import { getToken } from '@/utils/token';

function applySessionUser(
  dispatch: ReturnType<typeof useDispatch>,
  user: {
    id?: string;
    email: string;
    name: string;
    avatar?: string | null;
    provider: string;
    bio?: string | null;
    role?: string;
  },
  token?: string
) {
  dispatch(
    setSession({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        provider: user.provider,
        bio: user.bio,
        role: user.role,
      },
      token,
    })
  );
}

async function runQuietly(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch {
    /* ignore */
  }
}

function App() {
  const dispatch = useDispatch();
  const userId = useSelector((state: any) => state.auth?.user?.id as string | undefined);

  useEffect(() => {
    if (!isLocalCanvasMode() || userId === LOCAL_CANVAS_USER.id) return;
    dispatch(setUser(LOCAL_CANVAS_USER));
  }, [dispatch, userId]);

  useEffect(() => {
    if (isLocalCanvasMode()) return undefined;

    const onUnauthorized = () => {
      dispatch(logout());
      dispatch(clearProjectsLibrary());
      clearSessionCaches();
      clearProjectsListCache();
      clearWalletCache();
    };
    window.addEventListener('recombine:auth-unauthorized', onUnauthorized);
    return () => window.removeEventListener('recombine:auth-unauthorized', onUnauthorized);
  }, [dispatch]);

  useEffect(() => {
    if (isLocalCanvasMode()) return undefined;

    let cancelled = false;

    async function prefetchWallet() {
      if (!getToken()) return;
      await runQuietly(async () => {
        await queryClient.prefetchQuery({
          ...apiQuery.walletWalletMe.queryOptions(),
          ...WALLET_ME_QUERY_OPTS,
        });
      });
    }

    async function refreshMe() {
      if (!getToken()) return false;
      try {
        const res = (await queryClient.fetchQuery({
          ...apiQuery.authAuthMe.queryOptions(),
          staleTime: 30_000,
        })) as {
          user: {
            id?: string;
            email: string;
            name: string;
            avatar?: string | null;
            provider: string;
            bio?: string | null;
            role?: string;
          };
        };
        if (cancelled || !getToken()) return false;
        applySessionUser(dispatch, res.user, getToken() || undefined);
        return true;
      } catch {
        return false;
      }
    }

    async function prefetchBillingFlag() {
      await runQuietly(async () => {
        await queryClient.prefetchQuery({
          ...apiQuery.authAuthConfig.queryOptions(),
          staleTime: 60_000,
        });
      });
    }

    async function boot() {
      await prefetchBillingFlag();
      if (cancelled) return;
      await refreshMe();
      await prefetchWallet();
    }

    boot();
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  return <AppRouter />;
}

export default memo(App);
