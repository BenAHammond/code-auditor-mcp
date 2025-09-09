import React, { useState, useEffect, memo } from 'react';

interface ButtonProps {
  onClick: () => void;
  label: string;
  disabled?: boolean;
}

// Functional component with hooks
export const Button: React.FC<ButtonProps> = ({ onClick, label, disabled = false }) => {
  const [isClicked, setIsClicked] = useState(false);
  
  useEffect(() => {
    if (isClicked) {
      const timeout = setTimeout(() => setIsClicked(false), 1000);
      return () => clearTimeout(timeout);
    }
  }, [isClicked]);

  const handleClick = () => {
    setIsClicked(true);
    onClick();
  };

  return (
    <button 
      onClick={handleClick}
      disabled={disabled}
      className={isClicked ? 'clicked' : ''}
    >
      {label}
    </button>
  );
};

// Class component
export class TodoList extends React.Component<{items: string[]}, {filter: string}> {
  state = { filter: '' };

  handleFilterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ filter: e.target.value });
  };

  render() {
    const { items } = this.props;
    const { filter } = this.state;
    
    const filteredItems = items.filter(item => 
      item.toLowerCase().includes(filter.toLowerCase())
    );

    return (
      <div>
        <input 
          type="text" 
          value={filter} 
          onChange={this.handleFilterChange}
          placeholder="Filter todos..."
        />
        <ul>
          {filteredItems.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </div>
    );
  }
}

// Memoized component
export const ExpensiveList = memo(({ data }: { data: any[] }) => {
  // Complex calculation
  const processedData = data.map(item => ({
    ...item,
    computed: Math.random() * 100
  }));

  return (
    <div>
      {processedData.map((item, i) => (
        <div key={i}>{item.computed}</div>
      ))}
    </div>
  );
});

// Component with missing key in list (violation)
export function BadList({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map(item => (
        <li>{item}</li>
      ))}
    </ul>
  );
}

// Component with inline function prop (performance issue)
export function PerformanceIssue() {
  const [count, setCount] = useState(0);
  
  return (
    <div>
      <Button 
        onClick={() => setCount(count + 1)} 
        label="Click me"
      />
      <p>Count: {count}</p>
    </div>
  );
}