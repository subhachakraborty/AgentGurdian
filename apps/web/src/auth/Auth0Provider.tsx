import React from 'react';
import { Auth0Provider } from '@auth0/auth0-react';
import { useNavigate } from 'react-router-dom';

interface Props {
  children: React.ReactNode;
}

export function Auth0ProviderWithNavigate({ children }: Props) {
  const navigate = useNavigate();

  const domain = import.meta.env.VITE_AUTH0_DOMAIN;
  const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE;
  const redirectUri = import.meta.env.VITE_AUTH0_REDIRECT_URI || window.location.origin + '/callback';

  const onRedirectCallback = (appState: any) => {
    if (appState?.stepUp && appState?.jobId) {
      navigate(`/step-up-complete?jobId=${appState.jobId}`);
    } else {
      navigate(appState?.returnTo || '/');
    }
  };

  if (!domain || !clientId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface">
        <div className="card p-8 max-w-md text-center">
          <h2 className="text-xl font-bold text-brand mb-4">⚙️ Auth0 Configuration Required</h2>
          <p className="text-text-muted mb-4">
            Set <code className="bg-slate-100 px-1 rounded">VITE_AUTH0_DOMAIN</code> and{' '}
            <code className="bg-slate-100 px-1 rounded">VITE_AUTH0_CLIENT_ID</code> in your environment.
          </p>
          <p className="text-sm text-text-muted">
            Check <code>.env.example</code> for the full list of required variables.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        redirect_uri: redirectUri,
        audience: audience,
        scope: 'openid profile email',
      }}
      onRedirectCallback={onRedirectCallback}
      cacheLocation="localstorage"
      useRefreshTokens={true}
    >
      {children}
    </Auth0Provider>
  );
}
