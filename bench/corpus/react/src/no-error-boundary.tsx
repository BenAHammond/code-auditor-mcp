import React, { useEffect, useState } from 'react';

interface AsyncWidgetProps {
  resourceId: string;
}

// True positive: component with useEffect captured as hook → triggers no-error-boundary
// Uses direct `useEffect` import (not React.useEffect) so extractHooks captures it
export function AsyncWidget({ resourceId }: AsyncWidgetProps): JSX.Element {
  const [resource, setResource] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/resource/${resourceId}`)
      .then(r => r.json())
      .then(setResource);
  }, [resourceId]);

  return (
    <div className="async-widget">
      {resource ? <p>{resource.title}</p> : <p>Loading resource...</p>}
    </div>
  );
}

// Near-miss: simple component with no hooks and low complexity — does NOT trigger no-error-boundary
interface StaticLabelProps {
  text: string;
}

export function StaticLabel({ text }: StaticLabelProps): JSX.Element {
  return <span>{text}</span>;
}
