// Module that should be reported as unused when imported
export const unusedFunction = () => {
  console.log('This should not be called');
};

export type UnusedType = {
  field: string;
};