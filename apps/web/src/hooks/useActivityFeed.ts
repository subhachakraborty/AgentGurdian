import { useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';
import { useActivityStore } from '../stores/activityStore';
import { getSocket, connectSocket } from '../lib/socket';

export function useActivityFeed() {
  const { user } = useAuth0();
  const {
    activities,
    setActivities,
    addActivity,
    addPendingAction,
    removePendingAction,
    setPendingActions,
    showStepUpModal,
  } = useActivityStore();

  // Fetch initial activity log
  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs'],
    queryFn: async () => {
      const res = await apiClient.get('/audit', { params: { limit: 50 } });
      return res.data;
    },
    enabled: !!user,
  });

  useEffect(() => {
    if (data?.logs) {
      setActivities(data.logs);
    }
  }, [data, setActivities]);

  useEffect(() => {
    if (!user) return;

    apiClient.get('/agent/pending')
      .then((res) => {
        setPendingActions(res.data ?? []);
      })
      .catch((err) => {
        console.warn('Failed to load pending actions:', err?.response?.data ?? err.message);
      });
  }, [user, setPendingActions]);

  // Socket.io real-time events
  useEffect(() => {
    if (!user?.sub) return;

    connectSocket(user.sub);
    const socket = getSocket();

    socket.on('activity:new', ({ auditLog }) => {
      addActivity(auditLog);
    });

    socket.on('nudge:request', ({ pendingAction }) => {
      addPendingAction(pendingAction);
    });

    socket.on('nudge:resolved', ({ jobId }) => {
      removePendingAction(jobId);
    });

    socket.on('nudge:expired', ({ jobId }) => {
      removePendingAction(jobId);
    });

    socket.on('stepup:required', ({ jobId, challengeUrl }) => {
      showStepUpModal(jobId, challengeUrl);
    });

    return () => {
      socket.off('activity:new');
      socket.off('nudge:request');
      socket.off('nudge:resolved');
      socket.off('nudge:expired');
      socket.off('stepup:required');
    };
  }, [user?.sub, addActivity, addPendingAction, removePendingAction, showStepUpModal]);

  return { activities, isLoading, total: data?.total ?? 0 };
}
