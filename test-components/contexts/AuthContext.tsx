import React from 'react';

export const AuthContext = React.createContext({
  user: null as any,
  login: (credentials: any) => {},
  logout: () => {}
});