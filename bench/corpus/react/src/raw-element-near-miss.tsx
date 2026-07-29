import React from 'react';
import { Button } from './raw-element';

/**
 * Near-miss for raw-element: uses the <Button> wrapper component
 * instead of raw <button>. No violations expected because:
 *
 * 1. Uses React.createElement() with the imported Button component —
 *    tree-sitter sees ordinary function calls, not JSX intrinsic elements.
 *    The raw-element detector only scans JSX nodes for lowercase tags.
 *
 * 2. No JSX = no component detection = no missing-props, no performance
 *    (inline function props), no accessibility (div onClick) issues.
 *
 * Button is a capitalized component reference, not an HTML intrinsic.
 * Even if parsed as JSX, uppercase-first tags are filtered out.
 */
const elements = [
  React.createElement(Button, { key: 'home' }, 'Home'),
  React.createElement(Button, { key: 'settings' }, 'Settings'),
  React.createElement(Button, { key: 'profile' }, 'Profile'),
];
