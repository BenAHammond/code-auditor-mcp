/** A styled button that mixes a defined class with a near-miss typo of one. */
export function Button(): JSX.Element {
  return <button className="card cardd" style={{ color: '#1a2b3c' }}>Save</button>;
}
