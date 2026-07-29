import React from 'react';

/**
 * Wrapper component — exported, renders a single <button> intrinsic element.
 * Auto-detection picks this up as the canonical wrapper for <button> because:
 * 1. It's exported
 * 2. Its jsxElements contains exactly one watch-list intrinsic element (<button>)
 */
export function Button({ children, onClick, type }: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
}) {
  return <button type={type} onClick={onClick}>{children}</button>;
}

/**
 * Components using raw <button> instead of the <Button> wrapper.
 * Each raw <button> JSX element is a violation when total usage >= minUsages.
 */

function LoginForm() {
  return (
    <div>
      <button type="submit">Login</button>
      <button type="reset">Reset</button>
    </div>
  );
}

function SignupForm() {
  return (
    <div>
      <button type="submit">Sign Up</button>
    </div>
  );
}

function DeleteButton() {
  return (
    <div>
      <button onClick={() => {}}>Delete</button>
    </div>
  );
}

function NavBar() {
  return (
    <nav>
      <button>Home</button>
      <button>About</button>
      <button>Contact</button>
    </nav>
  );
}
