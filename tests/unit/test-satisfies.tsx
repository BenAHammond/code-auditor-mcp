import React, { CSSProperties, useRef } from 'react';

// Module-level satisfies expression - CSSProperties should be marked as used
const styles = {
  container: {
    display: 'flex',
    padding: '10px'
  },
  button: {
    backgroundColor: 'blue',
    color: 'white'
  }
} satisfies Record<string, CSSProperties>;

export function AddTodoForm() {
  const formRef = useRef<HTMLFormElement>(null);
  
  return (
    <form ref={formRef} style={styles.container}>
      <button style={styles.button}>Submit</button>
    </form>
  );
}