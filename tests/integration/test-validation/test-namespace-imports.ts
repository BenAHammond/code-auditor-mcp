// Test namespace import usage detection
import * as React from 'react';
import * as Types from './types';
import * as Unused from './unused-module';

// Test 1: React namespace usage
const Component: React.FC = () => {
  const [state, setState] = React.useState(0);
  
  React.useEffect(() => {
    console.log('mounted');
  }, []);
  
  return React.createElement('div', null, 'Hello');
};

// Test 2: Types namespace usage
const data: Types.BaseType = {
  name: 'test',
  value: 42
};

function processConfig(config: Types.ConfigType): void {
  console.log(config);
}

// Test 3: Namespace in JSX
const App = () => {
  return (
    <React.Fragment>
      <Component />
    </React.Fragment>
  );
};

// Test 4: Namespace in type position only
type ReactComponent = React.ComponentType<any>;
interface Props extends React.HTMLAttributes<HTMLDivElement> {}

// Unused namespace should still be reported as unused
// Even though we're importing * as Unused