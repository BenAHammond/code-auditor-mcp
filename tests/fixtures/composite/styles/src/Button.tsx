/** A styled button that mixes a defined class with an undefined one. */
export function Button(): JSX.Element {
  return <button className="card undefined-card" style={{ color: '#1a2b3c' }}>Save</button>;
}
