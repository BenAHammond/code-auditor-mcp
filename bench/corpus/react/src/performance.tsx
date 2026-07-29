import React from 'react';

// True positive 1: complexity 6 functional component → triggers performance
// (with requireMemoization: true in bench config)
export function HeavyRenderer({ data }: { data: any[] }): JSX.Element {
  if (!data) return <span>No data</span>;
  if (!Array.isArray(data)) return <span>Invalid type</span>;
  if (data.length > 100) return <span>Too many items</span>;
  if (data.length === 0) return <span>No items to display</span>;
  return (
    <ul>
      {data.map((item, i) => (
        <li key={i}>{item.name}</li>
      ))}
    </ul>
  );
}

// True positive 2: pre-component context line contains both => and onClick,
// which triggers the inline-function-perf heuristic
const inlineHandler = () => console.log('onClick triggered');

export function InlineClick({ label }: { label: string }): JSX.Element {
  return <button>{label}</button>;
}

// Near-miss: complexity 1 functional component — below memoization threshold
export function LightRenderer({ text }: { text: string }): JSX.Element {
  return <span>{text}</span>;
}
