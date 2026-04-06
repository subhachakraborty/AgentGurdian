import axios from 'axios';

const browserOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || browserOrigin || 'http://localhost:3001';

export const apiClient = axios.create({
  baseURL: `${API_BASE_URL}/api/v1`,
  headers: { 'Content-Type': 'application/json' },
});

// Auth0 token interceptor — set by useAuthToken hook
let getAccessToken: (() => Promise<string>) | null = null;

export function setTokenGetter(getter: () => Promise<string>) {
  getAccessToken = getter;
}

apiClient.interceptors.request.use(async (config) => {
  if (getAccessToken) {
    try {
      const token = await getAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
    } catch (err) {
      console.warn('Failed to get access token:', err);
    }
  }
  return config;
});

// Response interceptor for 401 handling
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Token expired or invalid — trigger re-auth
      console.warn('401 Unauthorized — token may be expired');
    }
    return Promise.reject(error);
  }
);
