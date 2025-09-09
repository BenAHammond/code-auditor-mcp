import React from 'react';

// Simple functional component with destructured props
export function SimpleButton({ onClick, label, disabled = false }: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}

// Another pattern - arrow function with props interface
interface CardProps {
  title: string;
  content: string;
  footer?: React.ReactNode;
}

export const Card = ({ title, content, footer }: CardProps) => {
  return (
    <div className="card">
      <h2>{title}</h2>
      <p>{content}</p>
      {footer && <div className="footer">{footer}</div>}
    </div>
  );
};