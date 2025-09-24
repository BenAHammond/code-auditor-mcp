import React from 'react';

export const AnalyticsContext = React.createContext({
  trackEvent: (event: string, data?: any) => {}
});