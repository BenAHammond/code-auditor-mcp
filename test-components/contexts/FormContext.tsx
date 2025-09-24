import React from 'react';

export const FormContext = React.createContext({
  validationRules: {},
  submitEndpoint: '/api/submit'
});