/**
 * Tailwind Utility Class Expander — Spec 22 R1
 *
 * Generates the full set of valid Tailwind utility classes from default theme
 * scales plus arbitrary-value grammar, variant prefix stripping, and project
 * config resolution. Replaces the hand-curated ~30-class Set previously in
 * UniversalStylesAnalyzer.detectUndefinedClasses.
 *
 * Fail-open rule (per Spec 22 R1.3): if project Tailwind config resolution
 * fails, the undefined-class detector disables for that project with one
 * visible warning naming the failure. A claim that a class "does not exist"
 * may not ship on a known-incomplete dictionary.
 */

import { loadTailwindConfig, type TailwindConfigResult } from './tailwindConfigLoader.js';

// ─── Variant Prefixes ──────────────────────────────────────────────────────

/**
 * Tailwind variant prefixes that modify utilities.
 * When stripped, the underlying class should match a known utility or
 * arbitrary-value pattern.
 */
const VARIANT_PREFIXES = [
  // Responsive
  'sm', 'md', 'lg', 'xl', '2xl',
  // State
  'hover', 'focus', 'active', 'disabled', 'visited',
  'focus-visible', 'focus-within', 'focus-visible',
  // Form
  'checked', 'indeterminate', 'required', 'valid', 'invalid',
  'in-range', 'out-of-range', 'placeholder-shown', 'autofill', 'read-only',
  // Structure
  'first', 'last', 'only', 'odd', 'even', 'first-of-type', 'last-of-type', 'only-of-type',
  'empty',
  // Mode
  'dark', 'light',
  // Group
  'group-hover', 'group-focus', 'group-focus-visible', 'group-focus-within',
  'group-active', 'group-disabled', 'group-visited', 'group-checked',
  // Peer
  'peer-hover', 'peer-focus', 'peer-focus-visible', 'peer-active',
  'peer-disabled', 'peer-checked', 'peer-invalid', 'peer-required',
  // Motion
  'motion-safe', 'motion-reduce',
  // Other
  'before', 'after', 'first-letter', 'first-line',
  'marker', 'selection', 'target', 'file', 'placeholder',
  'rtl', 'ltr',
  'open', 'closed',
  'portrait', 'landscape',
  'print',
  // Aria
  'aria-checked', 'aria-disabled',
  'has-[:checked]', 'has-[:disabled]',
  // Redundant but safe: already covered by individual state modifiers
];

// ─── Utility Prefixes (for arbitrary-value grammar) ─────────────────────────

/**
 * Known Tailwind utility prefixes that can accept arbitrary values via
 * the `prefix-[...]` syntax. Covers spacing, color, sizing, and other
 * commonly-arbitrary-value'd families.
 */
const ARBITRARY_VALUE_PREFIXES = new Set([
  // Spacing-based
  'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl',
  'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml',
  'gap', 'gap-x', 'gap-y',
  'w', 'min-w', 'max-w', 'h', 'min-h', 'max-h',
  'top', 'right', 'bottom', 'left', 'inset',
  'inset-x', 'inset-y',
  'translate-x', 'translate-y', 'translate',
  'skew-x', 'skew-y', 'skew',
  'rotate',
  'scale', 'scale-x', 'scale-y',
  'space-x', 'space-y',
  'leading', 'tracking', 'indent',
  'scroll-m', 'scroll-mx', 'scroll-my', 'scroll-mt', 'scroll-mr', 'scroll-mb', 'scroll-ml',
  'scroll-p', 'scroll-px', 'scroll-py', 'scroll-pt', 'scroll-pr', 'scroll-pb', 'scroll-pl',
  // Color-based
  'bg', 'text', 'border', 'ring', 'ring-offset', 'shadow',
  'fill', 'stroke', 'outline', 'accent', 'caret',
  'placeholder', 'divide',
  'from', 'via', 'to', // gradient stops
  'decoration',
  // Sizing
  'basis', 'grow', 'shrink',
  'order',
  'z', // z-index
  // Border
  'rounded', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l',
  'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl',
  'rounded-s', 'rounded-e', 'rounded-ss', 'rounded-se', 'rounded-es', 'rounded-ee',
  'border', 'border-t', 'border-r', 'border-b', 'border-l',
  'border-x', 'border-y',
  'outline',
  'outline-offset',
  // Text
  'text', 'text-wrap',
  'underline-offset',
  // Opacity
  'opacity',
  'bg-opacity', 'text-opacity', 'border-opacity', 'ring-opacity',
  'divide-opacity', 'placeholder-opacity',
  // Shadow
  'shadow',
  // Duration / timing
  'duration', 'delay', 'easing',
  // Animation
  'animate',
  // Grid
  'grid-cols', 'grid-rows', 'auto-cols', 'auto-rows',
  'col', 'col-start', 'col-end', 'col-span',
  'row', 'row-start', 'row-end', 'row-span',
  // Columns
  'columns',
  // Filter
  'blur', 'brightness', 'contrast', 'grayscale', 'hue-rotate',
  'invert', 'saturate', 'sepia', 'drop-shadow',
  'backdrop-blur', 'backdrop-brightness', 'backdrop-contrast',
  'backdrop-grayscale', 'backdrop-hue-rotate', 'backdrop-invert',
  'backdrop-opacity', 'backdrop-saturate', 'backdrop-sepia',
  // Aspect ratio
  'aspect',
  // Break
  'break',
  // Container queries
  '@',
]);

/**
 * Prefixes that allow a negative sign to be prepended to the utility.
 * e.g., -mt-1 (negative margin-top), -top-2 (negative position).
 */
const NEGATIVE_ALLOWED_PREFIXES = new Set([
  // Margin — negative margins pull elements closer / overlap
  'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml',
  // Position — negative offsets move element beyond container edge
  'top', 'right', 'bottom', 'left',
  // Inset
  'inset', 'inset-x', 'inset-y',
  // Z-index
  'z',
  // Transform
  'translate-x', 'translate-y',
  'rotate',
  'scale', 'scale-x', 'scale-y',
  'skew-x', 'skew-y',
  // Indent (negative text indent)
  'indent',
]);

// ─── Static Utility Classes ─────────────────────────────────────────────────

/**
 * Standard Tailwind utility classes that don't depend on a theme scale.
 * These are the fixed-name classes: display, flex, grid, alignment, etc.
 */
function getStaticUtilityClasses(): string[] {
  return [
    // Display
    'block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid',
    'inline-grid', 'hidden', 'flow-root', 'contents', 'table', 'table-row',
    'table-cell', 'table-caption', 'table-column', 'table-column-group',
    'table-footer-group', 'table-header-group', 'table-row-group', 'list-item',
    // Position
    'static', 'fixed', 'absolute', 'relative', 'sticky',
    // Flex direction
    'flex-row', 'flex-row-reverse', 'flex-col', 'flex-col-reverse',
    'flex-wrap', 'flex-nowrap', 'flex-wrap-reverse',
    'flex-1', 'flex-auto', 'flex-initial', 'flex-none',
    'grow', 'grow-0', 'shrink', 'shrink-0',
    'flex-grow', 'flex-grow-0', 'flex-shrink', 'flex-shrink-0',
    'group',
    // Grid
    'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4',
    'grid-cols-5', 'grid-cols-6', 'grid-cols-7', 'grid-cols-8',
    'grid-cols-9', 'grid-cols-10', 'grid-cols-11', 'grid-cols-12',
    'grid-cols-none', 'grid-cols-subgrid',
    'grid-rows-1', 'grid-rows-2', 'grid-rows-3', 'grid-rows-4',
    'grid-rows-5', 'grid-rows-6', 'grid-rows-none', 'grid-rows-subgrid',
    'grid-flow-row', 'grid-flow-col', 'grid-flow-dense', 'grid-flow-row-dense', 'grid-flow-col-dense',
    'auto-cols-auto', 'auto-cols-min', 'auto-cols-max', 'auto-cols-fr',
    'auto-rows-auto', 'auto-rows-min', 'auto-rows-max', 'auto-rows-fr',
    // Alignment
    'items-start', 'items-end', 'items-center', 'items-baseline', 'items-stretch',
    'justify-start', 'justify-end', 'justify-center', 'justify-between',
    'justify-around', 'justify-evenly', 'justify-stretch', 'justify-normal',
    'justify-items-start', 'justify-items-end', 'justify-items-center', 'justify-items-stretch',
    'content-center', 'content-start', 'content-end', 'content-between',
    'content-around', 'content-evenly', 'content-baseline', 'content-normal', 'content-stretch',
    'place-content-center', 'place-content-start', 'place-content-end',
    'place-content-between', 'place-content-around', 'place-content-evenly',
    'place-items-center', 'place-items-start', 'place-items-end', 'place-items-stretch',
    'self-auto', 'self-start', 'self-end', 'self-center', 'self-stretch', 'self-baseline',
    'place-self-auto', 'place-self-start', 'place-self-end', 'place-self-center', 'place-self-stretch',
    // Text alignment
    'text-left', 'text-center', 'text-right', 'text-justify', 'text-start', 'text-end',
    // Text decoration
    'underline', 'line-through', 'no-underline', 'overline',
    'decoration-solid', 'decoration-double', 'decoration-dotted', 'decoration-dashed', 'decoration-wavy',
    // Text transform
    'uppercase', 'lowercase', 'capitalize', 'normal-case',
    // Text overflow
    'truncate', 'text-ellipsis', 'text-clip',
    // Whitespace
    'whitespace-normal', 'whitespace-nowrap', 'whitespace-pre', 'whitespace-pre-line', 'whitespace-pre-wrap',
    'whitespace-break-spaces',
    // Word break
    'break-normal', 'break-words', 'break-all', 'break-keep', 'hyphens-none', 'hyphens-manual', 'hyphens-auto',
    // Font weight
    'font-thin', 'font-extralight', 'font-light', 'font-normal', 'font-medium',
    'font-semibold', 'font-bold', 'font-extrabold', 'font-black',
    // Font style
    'italic', 'not-italic',
    // Font variant
    'ordinal', 'slashed-zero', 'lining-nums', 'oldstyle-nums', 'proportional-nums',
    'tabular-nums', 'diagonal-fractions', 'stacked-fractions',
    // Width
    'w-auto', 'w-full', 'w-screen', 'w-svw', 'w-dvw', 'w-lvw', 'w-min', 'w-max', 'w-fit',
    'w-0', 'w-px', 'w-0.5', 'w-1', 'w-2', 'w-3', 'w-4', 'w-5', 'w-6', 'w-7', 'w-8',
    'w-9', 'w-10', 'w-11', 'w-12', 'w-14', 'w-16', 'w-20', 'w-24', 'w-28', 'w-32',
    'w-36', 'w-40', 'w-44', 'w-48', 'w-52', 'w-56', 'w-60', 'w-64', 'w-72', 'w-80', 'w-96',
    'w-1/2', 'w-1/3', 'w-2/3', 'w-1/4', 'w-2/4', 'w-3/4', 'w-1/5', 'w-2/5', 'w-3/5', 'w-4/5',
    'w-1/6', 'w-2/6', 'w-3/6', 'w-4/6', 'w-5/6',
    // Height
    'h-auto', 'h-full', 'h-screen', 'h-svh', 'h-dvh', 'h-lvh', 'h-min', 'h-max', 'h-fit',
    'h-0', 'h-px', 'h-0.5', 'h-1', 'h-2', 'h-3', 'h-4', 'h-5', 'h-6', 'h-7', 'h-8',
    'h-9', 'h-10', 'h-11', 'h-12', 'h-14', 'h-16', 'h-20', 'h-24', 'h-28', 'h-32',
    'h-36', 'h-40', 'h-44', 'h-48', 'h-52', 'h-56', 'h-60', 'h-64', 'h-72', 'h-80', 'h-96',
    'h-1/2', 'h-1/3', 'h-2/3', 'h-1/4', 'h-2/4', 'h-3/4', 'h-1/5', 'h-2/5', 'h-3/5', 'h-4/5',
    'h-1/6', 'h-2/6', 'h-3/6', 'h-4/6', 'h-5/6',
    // Min/max sizing
    'min-w-0', 'min-w-full', 'min-w-min', 'min-w-max', 'min-w-fit',
    'max-w-0', 'max-w-none', 'max-w-xs', 'max-w-sm', 'max-w-md', 'max-w-lg', 'max-w-xl',
    'max-w-2xl', 'max-w-3xl', 'max-w-4xl', 'max-w-5xl', 'max-w-6xl', 'max-w-7xl',
    'max-w-full', 'max-w-min', 'max-w-max', 'max-w-fit', 'max-w-prose',
    'max-w-screen-sm', 'max-w-screen-md', 'max-w-screen-lg', 'max-w-screen-xl', 'max-w-screen-2xl',
    'min-h-0', 'min-h-full', 'min-h-screen', 'min-h-min', 'min-h-max', 'min-h-fit',
    'max-h-0', 'max-h-full', 'max-h-screen', 'max-h-min', 'max-h-max', 'max-h-fit',
    // Size (both w and h)
    'size-auto', 'size-full', 'size-min', 'size-max', 'size-fit',
    // Overflow
    'overflow-auto', 'overflow-hidden', 'overflow-visible', 'overflow-scroll',
    'overflow-x-auto', 'overflow-x-hidden', 'overflow-x-visible', 'overflow-x-scroll',
    'overflow-y-auto', 'overflow-y-hidden', 'overflow-y-visible', 'overflow-y-scroll',
    // Cursor
    'cursor-auto', 'cursor-default', 'cursor-pointer', 'cursor-wait', 'cursor-text',
    'cursor-move', 'cursor-help', 'cursor-not-allowed', 'cursor-none',
    'cursor-context-menu', 'cursor-progress', 'cursor-cell', 'cursor-crosshair',
    'cursor-vertical-text', 'cursor-alias', 'cursor-copy', 'cursor-grab', 'cursor-grabbing',
    'cursor-no-drop', 'cursor-zoom-in', 'cursor-zoom-out',
    // Visibility
    'visible', 'invisible', 'collapse',
    // Border
    'border', 'border-0', 'border-2', 'border-4', 'border-8',
    'border-t', 'border-r', 'border-b', 'border-l',
    'border-t-0', 'border-r-0', 'border-b-0', 'border-l-0',
    'border-x', 'border-y',
    'border-solid', 'border-dashed', 'border-dotted', 'border-double', 'border-hidden', 'border-none',
    // Shadow
    'shadow', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-2xl',
    'shadow-inner', 'shadow-none',
    // Ring
    'ring', 'ring-0', 'ring-1', 'ring-2', 'ring-4', 'ring-8', 'ring-inset',
    'ring-offset-0', 'ring-offset-1', 'ring-offset-2', 'ring-offset-4', 'ring-offset-8',
    // Opacity
    'opacity-0', 'opacity-5', 'opacity-10', 'opacity-20', 'opacity-25', 'opacity-30',
    'opacity-40', 'opacity-50', 'opacity-60', 'opacity-70', 'opacity-75', 'opacity-80',
    'opacity-90', 'opacity-95', 'opacity-100',
    // Z-index
    'z-0', 'z-10', 'z-20', 'z-30', 'z-40', 'z-50', 'z-auto',
    // Object fit
    'object-contain', 'object-cover', 'object-fill', 'object-none', 'object-scale-down',
    // Object position
    'object-bottom', 'object-center', 'object-left', 'object-left-bottom',
    'object-left-top', 'object-right', 'object-right-bottom', 'object-right-top', 'object-top',
    // Transition
    'transition-none', 'transition-all', 'transition', 'transition-colors',
    'transition-opacity', 'transition-shadow', 'transition-transform',
    // Duration
    'duration-0', 'duration-75', 'duration-100', 'duration-150', 'duration-200',
    'duration-300', 'duration-500', 'duration-700', 'duration-1000',
    // Delay
    'delay-0', 'delay-75', 'delay-100', 'delay-150', 'delay-200', 'delay-300',
    'delay-500', 'delay-700', 'delay-1000',
    // Timing
    'ease-linear', 'ease-in', 'ease-out', 'ease-in-out',
    // Transform
    'transform', 'transform-gpu', 'transform-none',
    'scale-0', 'scale-50', 'scale-75', 'scale-90', 'scale-95', 'scale-100',
    'scale-105', 'scale-110', 'scale-125', 'scale-150',
    'scale-x-0', 'scale-x-50', 'scale-x-75', 'scale-x-90', 'scale-x-95', 'scale-x-100',
    'scale-x-105', 'scale-x-110', 'scale-x-125', 'scale-x-150',
    'scale-y-0', 'scale-y-50', 'scale-y-75', 'scale-y-90', 'scale-y-95', 'scale-y-100',
    'scale-y-105', 'scale-y-110', 'scale-y-125', 'scale-y-150',
    'rotate-0', 'rotate-1', 'rotate-2', 'rotate-3', 'rotate-6', 'rotate-12',
    'rotate-45', 'rotate-90', 'rotate-180',
    'origin-center', 'origin-top', 'origin-top-right', 'origin-right',
    'origin-bottom-right', 'origin-bottom', 'origin-bottom-left', 'origin-left', 'origin-top-left',
    // Box sizing
    'box-border', 'box-content',
    // Container
    'container',
    // Pointer events
    'pointer-events-none', 'pointer-events-auto',
    // Resize
    'resize-none', 'resize', 'resize-y', 'resize-x',
    // User select
    'select-none', 'select-text', 'select-all', 'select-auto',
    // Screen readers
    'sr-only', 'not-sr-only',
    // Background
    'bg-auto', 'bg-cover', 'bg-contain',
    'bg-bottom', 'bg-center', 'bg-left', 'bg-left-bottom', 'bg-left-top',
    'bg-right', 'bg-right-bottom', 'bg-right-top', 'bg-top',
    'bg-fixed', 'bg-local', 'bg-scroll',
    'bg-no-repeat', 'bg-repeat', 'bg-repeat-x', 'bg-repeat-y', 'bg-repeat-round', 'bg-repeat-space',
    'bg-none', 'bg-origin-border', 'bg-origin-padding', 'bg-origin-content',
    'bg-clip-border', 'bg-clip-padding', 'bg-clip-content', 'bg-clip-text',
    // Gradient
    'bg-gradient-to-t', 'bg-gradient-to-tr', 'bg-gradient-to-r', 'bg-gradient-to-br',
    'bg-gradient-to-b', 'bg-gradient-to-bl', 'bg-gradient-to-l', 'bg-gradient-to-tl',
    'bg-none',
    // List style
    'list-none', 'list-disc', 'list-decimal', 'list-image-none',
    'list-inside', 'list-outside',
    // Table
    'table-auto', 'table-fixed',
    'border-collapse', 'border-separate',
    'border-spacing-0', 'border-spacing-1', 'border-spacing-2',
    'border-spacing-x-0', 'border-spacing-y-0',
    'table-layout-auto', 'table-layout-fixed',
    'caption-top', 'caption-bottom',
    // Vertical align
    'align-baseline', 'align-top', 'align-middle', 'align-bottom',
    'align-text-top', 'align-text-bottom', 'align-sub', 'align-super',
    // Aspect ratio
    'aspect-auto', 'aspect-square', 'aspect-video',
    // Columns
    'columns-1', 'columns-2', 'columns-3', 'columns-4', 'columns-5', 'columns-6',
    'columns-7', 'columns-8', 'columns-9', 'columns-10', 'columns-11', 'columns-12',
    'columns-auto', 'columns-3xs', 'columns-2xs', 'columns-xs', 'columns-sm',
    'columns-md', 'columns-lg', 'columns-xl', 'columns-2xl', 'columns-3xl',
    'columns-4xl', 'columns-5xl', 'columns-6xl', 'columns-7xl',
    'break-before-auto', 'break-before-avoid', 'break-before-all', 'break-before-avoid-page', 'break-before-page',
    'break-before-left', 'break-before-right', 'break-before-column',
    'break-after-auto', 'break-after-avoid', 'break-after-all', 'break-after-avoid-page', 'break-after-page',
    'break-after-left', 'break-after-right', 'break-after-column',
    'break-inside-auto', 'break-inside-avoid', 'break-inside-avoid-page', 'break-inside-avoid-column',
    // Float
    'float-right', 'float-left', 'float-none', 'float-start', 'float-end',
    'clear-left', 'clear-right', 'clear-both', 'clear-none', 'clear-start', 'clear-end',
    // Box decoration
    'decoration-slice', 'decoration-clone',
    'box-decoration-slice', 'box-decoration-clone',
    // Isolation
    'isolate', 'isolation-auto',
    // Overscroll
    'overscroll-auto', 'overscroll-contain', 'overscroll-none',
    'overscroll-x-auto', 'overscroll-x-contain', 'overscroll-x-none',
    'overscroll-y-auto', 'overscroll-y-contain', 'overscroll-y-none',
    'overscroll-behavior-auto', 'overscroll-behavior-contain', 'overscroll-behavior-none',
    // Scroll snap
    'snap-none', 'snap-x', 'snap-y', 'snap-both', 'snap-mandatory', 'snap-proximity',
    'snap-start', 'snap-end', 'snap-center', 'snap-align-none', 'snap-normal', 'snap-always',
    // Scroll behavior
    'scroll-auto', 'scroll-smooth',
    // Appearance
    'appearance-none', 'appearance-auto',
    // Touch
    'touch-auto', 'touch-none', 'touch-pan-x', 'touch-pan-left', 'touch-pan-right',
    'touch-pan-y', 'touch-pan-up', 'touch-pan-down', 'touch-pinch-zoom',
    'touch-manipulation',
    // Will change
    'will-change-auto', 'will-change-scroll', 'will-change-contents', 'will-change-transform',
    // Content
    'content-none',
    // Blend mode
    'mix-blend-normal', 'mix-blend-multiply', 'mix-blend-screen', 'mix-blend-overlay',
    'mix-blend-darken', 'mix-blend-lighten', 'mix-blend-color-dodge', 'mix-blend-color-burn',
    'mix-blend-hard-light', 'mix-blend-soft-light', 'mix-blend-difference',
    'mix-blend-exclusion', 'mix-blend-hue', 'mix-blend-saturation', 'mix-blend-color', 'mix-blend-luminosity',
    'mix-blend-plus-darker', 'mix-blend-plus-lighter',
    'bg-blend-normal', 'bg-blend-multiply', 'bg-blend-screen', 'bg-blend-overlay',
    'bg-blend-darken', 'bg-blend-lighten', 'bg-blend-color-dodge', 'bg-blend-color-burn',
    // Gap
    'gap-0', 'gap-px', 'gap-0.5', 'gap-1', 'gap-2', 'gap-3', 'gap-4', 'gap-5',
    'gap-6', 'gap-7', 'gap-8', 'gap-9', 'gap-10', 'gap-11', 'gap-12',
    'gap-14', 'gap-16', 'gap-20', 'gap-24', 'gap-28', 'gap-32', 'gap-36', 'gap-40',
    'gap-44', 'gap-48', 'gap-52', 'gap-56', 'gap-60', 'gap-64', 'gap-72', 'gap-80', 'gap-96',
    'gap-x-0', 'gap-y-0',
    // Space
    'space-x-0', 'space-y-0',
    // Divide
    'divide-x', 'divide-y',
    'divide-x-0', 'divide-y-0',
    'divide-solid', 'divide-dashed', 'divide-dotted', 'divide-double', 'divide-none',
    'divide-x-reverse', 'divide-y-reverse',
    // Ring
    'ring-inset',
    // Line clamp
    'line-clamp-1', 'line-clamp-2', 'line-clamp-3', 'line-clamp-4', 'line-clamp-5', 'line-clamp-6', 'line-clamp-none',
    // Animation
    'animate-none', 'animate-spin', 'animate-ping', 'animate-pulse', 'animate-bounce',
    // Font family
    'font-sans', 'font-serif', 'font-mono',
    // Letter spacing (tracking)
    'tracking-tighter', 'tracking-tight', 'tracking-normal',
    'tracking-wide', 'tracking-wider', 'tracking-widest',
    // Backdrop filters
    'backdrop-blur', 'backdrop-blur-sm', 'backdrop-blur-md', 'backdrop-blur-lg',
    'backdrop-blur-xl', 'backdrop-blur-2xl', 'backdrop-blur-3xl', 'backdrop-blur-none',
    'backdrop-opacity-0', 'backdrop-opacity-50', 'backdrop-opacity-100',
  ];
}

// ─── Generated Utility Classes (from theme scales) ──────────────────────────

/**
 * Generate all valid Tailwind utility classes by combining known prefixes with
 * default theme scales + common string values for non-scale prefixes.
 */
function generateScaleBasedClasses(): string[] {
  const classes: string[] = [];

  // Color prefixes — generate bg-{color}, text-{color}, etc.
  const colorPrefixes = [
    'bg', 'text', 'border', 'ring', 'shadow', 'fill', 'stroke',
    'accent', 'caret', 'outline', 'placeholder', 'divide', 'from', 'via', 'to',
    'decoration',
  ];

  // Color names from the default Tailwind palette
  const colorNames = [
    'inherit', 'current', 'transparent',
    'white', 'black',
    // Slate
    'slate-50', 'slate-100', 'slate-200', 'slate-300', 'slate-400', 'slate-500',
    'slate-600', 'slate-700', 'slate-800', 'slate-900', 'slate-950',
    // Gray
    'gray-50', 'gray-100', 'gray-200', 'gray-300', 'gray-400', 'gray-500',
    'gray-600', 'gray-700', 'gray-800', 'gray-900', 'gray-950',
    // Zinc
    'zinc-50', 'zinc-100', 'zinc-200', 'zinc-300', 'zinc-400', 'zinc-500',
    'zinc-600', 'zinc-700', 'zinc-800', 'zinc-900', 'zinc-950',
    // Neutral
    'neutral-50', 'neutral-100', 'neutral-200', 'neutral-300', 'neutral-400', 'neutral-500',
    'neutral-600', 'neutral-700', 'neutral-800', 'neutral-900', 'neutral-950',
    // Stone
    'stone-50', 'stone-100', 'stone-200', 'stone-300', 'stone-400', 'stone-500',
    'stone-600', 'stone-700', 'stone-800', 'stone-900', 'stone-950',
    // Red
    'red-50', 'red-100', 'red-200', 'red-300', 'red-400', 'red-500',
    'red-600', 'red-700', 'red-800', 'red-900', 'red-950',
    // Orange
    'orange-50', 'orange-100', 'orange-200', 'orange-300', 'orange-400', 'orange-500',
    'orange-600', 'orange-700', 'orange-800', 'orange-900', 'orange-950',
    // Amber
    'amber-50', 'amber-100', 'amber-200', 'amber-300', 'amber-400', 'amber-500',
    'amber-600', 'amber-700', 'amber-800', 'amber-900', 'amber-950',
    // Yellow
    'yellow-50', 'yellow-100', 'yellow-200', 'yellow-300', 'yellow-400', 'yellow-500',
    'yellow-600', 'yellow-700', 'yellow-800', 'yellow-900', 'yellow-950',
    // Lime
    'lime-50', 'lime-100', 'lime-200', 'lime-300', 'lime-400', 'lime-500',
    'lime-600', 'lime-700', 'lime-800', 'lime-900', 'lime-950',
    // Green
    'green-50', 'green-100', 'green-200', 'green-300', 'green-400', 'green-500',
    'green-600', 'green-700', 'green-800', 'green-900', 'green-950',
    // Emerald
    'emerald-50', 'emerald-100', 'emerald-200', 'emerald-300', 'emerald-400', 'emerald-500',
    'emerald-600', 'emerald-700', 'emerald-800', 'emerald-900', 'emerald-950',
    // Teal
    'teal-50', 'teal-100', 'teal-200', 'teal-300', 'teal-400', 'teal-500',
    'teal-600', 'teal-700', 'teal-800', 'teal-900', 'teal-950',
    // Cyan
    'cyan-50', 'cyan-100', 'cyan-200', 'cyan-300', 'cyan-400', 'cyan-500',
    'cyan-600', 'cyan-700', 'cyan-800', 'cyan-900', 'cyan-950',
    // Sky
    'sky-50', 'sky-100', 'sky-200', 'sky-300', 'sky-400', 'sky-500',
    'sky-600', 'sky-700', 'sky-800', 'sky-900', 'sky-950',
    // Blue
    'blue-50', 'blue-100', 'blue-200', 'blue-300', 'blue-400', 'blue-500',
    'blue-600', 'blue-700', 'blue-800', 'blue-900', 'blue-950',
    // Indigo
    'indigo-50', 'indigo-100', 'indigo-200', 'indigo-300', 'indigo-400', 'indigo-500',
    'indigo-600', 'indigo-700', 'indigo-800', 'indigo-900', 'indigo-950',
    // Violet
    'violet-50', 'violet-100', 'violet-200', 'violet-300', 'violet-400', 'violet-500',
    'violet-600', 'violet-700', 'violet-800', 'violet-900', 'violet-950',
    // Purple
    'purple-50', 'purple-100', 'purple-200', 'purple-300', 'purple-400', 'purple-500',
    'purple-600', 'purple-700', 'purple-800', 'purple-900', 'purple-950',
    // Fuchsia
    'fuchsia-50', 'fuchsia-100', 'fuchsia-200', 'fuchsia-300', 'fuchsia-400', 'fuchsia-500',
    'fuchsia-600', 'fuchsia-700', 'fuchsia-800', 'fuchsia-900', 'fuchsia-950',
    // Pink
    'pink-50', 'pink-100', 'pink-200', 'pink-300', 'pink-400', 'pink-500',
    'pink-600', 'pink-700', 'pink-800', 'pink-900', 'pink-950',
    // Rose
    'rose-50', 'rose-100', 'rose-200', 'rose-300', 'rose-400', 'rose-500',
    'rose-600', 'rose-700', 'rose-800', 'rose-900', 'rose-950',
  ];

  // Special opacity variants for color prefixes that support it
  const dividerColors = new Set(['divide', 'border', 'ring', 'placeholder', 'text']);
  const opacityNumbers = ['0', '5', '10', '20', '25', '30', '40', '50', '60', '70', '75', '80', '90', '95', '100'];

  for (const prefix of colorPrefixes) {
    for (const colorName of colorNames) {
      classes.push(`${prefix}-${colorName}`);
      // Opacity modifiers for supported prefixes
      if (dividerColors.has(prefix)) {
        for (const opacity of opacityNumbers) {
          classes.push(`${prefix}-${colorName}/${opacity}`);
        }
      }
    }
  }

  // Font size prefixes
  const fontSizePrefixes = ['text'];
  const fontSizeNames = [
    'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
  ];
  for (const prefix of fontSizePrefixes) {
    for (const sizeName of fontSizeNames) {
      classes.push(`${prefix}-${sizeName}`);
    }
  }

  // Border radius prefixes
  const radiusPrefixes = [
    'rounded', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l',
    'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl',
    'rounded-s', 'rounded-e', 'rounded-ss', 'rounded-se', 'rounded-es', 'rounded-ee',
  ];
  const radiusNames = ['none', 'sm', '', 'md', 'lg', 'xl', '2xl', '3xl', 'full'];
  for (const prefix of radiusPrefixes) {
    for (const radiusName of radiusNames) {
      if (radiusName === '') {
        classes.push(prefix); // "rounded" alone
      } else {
        classes.push(`${prefix}-${radiusName}`);
      }
    }
  }

  // ── Spacing-scale utilities ─────────────────────────────────────────
  // Padding, margin, position, inset, gap-x, gap-y, space-x, space-y,
  // size, leading, indent, scroll-margin/padding — all accept the default
  // spacing scale as values.
  const spacingScaleValues = [
    '0', 'px', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7',
    '8', '9', '10', '11', '12', '14', '16', '20', '24', '28', '32', '36', '40',
    '44', '48', '52', '56', '60', '64', '72', '80', '96',
  ];

  // Spacing-based prefixes — utilities that accept spacing scale values
  const spacingPrefixes = [
    // Padding
    'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl',
    // Margin
    'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml',
    // Position
    'top', 'right', 'bottom', 'left',
    // Inset
    'inset', 'inset-x', 'inset-y',
    // Gap (gap-{x,y} — full scale; gap base already in static)
    'gap-x', 'gap-y',
    // Space (space-{x,y} — full scale)
    'space-x', 'space-y',
    // Size (both width and height)
    'size',
    // Scroll margin / padding
    'scroll-m', 'scroll-mx', 'scroll-my', 'scroll-mt', 'scroll-mr', 'scroll-mb', 'scroll-ml',
    'scroll-p', 'scroll-px', 'scroll-py', 'scroll-pt', 'scroll-pr', 'scroll-pb', 'scroll-pl',
  ];

  for (const prefix of spacingPrefixes) {
    for (const value of spacingScaleValues) {
      classes.push(`${prefix}-${value}`);
    }
  }

  // Special non-scale values for margin: auto
  for (const prefix of ['m', 'mx', 'my', 'mt', 'mr', 'mb', 'ml']) {
    classes.push(`${prefix}-auto`);
  }

  // Special non-scale values for position: auto, fractions, full
  for (const prefix of ['top', 'right', 'bottom', 'left']) {
    classes.push(`${prefix}-auto`);
    classes.push(`${prefix}-full`);
    for (const frac of ['1/2', '1/3', '2/3', '1/4', '3/4']) {
      classes.push(`${prefix}-${frac}`);
    }
  }

  // Special non-scale values for inset: auto, full, fractions
  for (const prefix of ['inset', 'inset-x', 'inset-y']) {
    classes.push(`${prefix}-auto`);
    classes.push(`${prefix}-full`);
    for (const frac of ['1/2', '1/3', '2/3', '1/4', '3/4']) {
      classes.push(`${prefix}-${frac}`);
    }
  }

  // Leading (line-height) — spacing values + text keywords
  for (const value of spacingScaleValues) {
    classes.push(`leading-${value}`);
  }
  for (const kw of ['none', 'tight', 'snug', 'normal', 'relaxed', 'loose']) {
    classes.push(`leading-${kw}`);
  }

  // Indent — spacing scale values
  for (const value of spacingScaleValues) {
    classes.push(`indent-${value}`);
  }

  // Border-width directional — only major widths for border-{side}-{width}
  for (const side of ['t', 'r', 'b', 'l', 'x', 'y']) {
    for (const w of ['0', '2', '4', '8']) {
      classes.push(`border-${side}-${w}`);
    }
  }

  // Opacity modifiers for bg/text/shadow/ring (non-divider color prefixes)
  // — divider colors (border/ring/placeholder/divide/text) already generated
  const nonDividerOpacityPrefixes = ['bg', 'shadow'];
  const opacityValues = ['0', '5', '10', '20', '25', '30', '40', '50', '60', '70', '75', '80', '90', '95', '100'];
  for (const prefix of nonDividerOpacityPrefixes) {
    for (const op of opacityValues) {
      classes.push(`${prefix}-opacity-${op}`);
    }
  }

  // Translate — fractions and full
  for (const prefix of ['translate-x', 'translate-y']) {
    for (const frac of ['1/2', '1/3', '2/3', '1/4', '3/4', 'full']) {
      classes.push(`${prefix}-${frac}`);
    }
  }


  // Grid column spans — col-span-{1..12}, col-start-{1..13}, col-end-{1..13}
  for (let i = 1; i <= 12; i++) classes.push(`col-span-${i}`);
  for (let i = 1; i <= 13; i++) {
    classes.push(`col-start-${i}`);
    classes.push(`col-end-${i}`);
  }

  // Grid row spans — row-span-{1..6}, row-start-{1..7}, row-end-{1..7}
  for (let i = 1; i <= 6; i++) classes.push(`row-span-${i}`);
  for (let i = 1; i <= 7; i++) {
    classes.push(`row-start-${i}`);
    classes.push(`row-end-${i}`);
  }

  // Outline utilities
  classes.push('outline-none', 'outline', 'outline-dashed', 'outline-dotted', 'outline-double');

  return classes;
}

// ─── Main Expander API ──────────────────────────────────────────────────────

/** Cached bundled utility classes. */
let _bundledClasses: Set<string> | null = null;

/**
 * Get the full set of bundled Tailwind utility classes.
 * Generated from the default theme scales plus static utilities.
 * Cached after first call — callers get the same Set instance.
 */
export function getBundledUtilityClasses(): Set<string> {
  if (_bundledClasses) return _bundledClasses;

  _bundledClasses = new Set<string>();

  // Static utilities
  for (const cls of getStaticUtilityClasses()) {
    _bundledClasses.add(cls);
  }

  // Scale-generated utilities
  for (const cls of generateScaleBasedClasses()) {
    _bundledClasses.add(cls);
  }

  return _bundledClasses;
}

/**
 * Result of resolving a Tailwind utility class against the full expansion path.
 */
export interface UtilityClassResolution {
  /** Is this a known/valid utility class? */
  valid: boolean;
  /**
   * Which tier resolved it: 'bundled' (default theme), 'project-config' (project
   * config resolution), 'arbitrary-value' (matches `prefix-[...]` grammar), or
   * 'none' (no match).
   */
  tier: 'bundled' | 'project-config' | 'arbitrary-value' | 'none';
}

/**
 * Configuration for the Tailwind utility class expansion.
 */
export interface TailwindExpanderConfig {
  /** Project root for loading Tailwind config. */
  projectRoot?: string;
  /** If true, load and include project Tailwind config custom classes. */
  useProjectConfig?: boolean;
  /** User-supplied class names from project config (use when useProjectConfig
   *  would fail — the caller pre-resolves and passes them). */
  customClasses?: Set<string>;
}

/**
 * Tailwind utility class expander.
 *
 * Validates a class name against the full expansion path:
 * 1. Bundled default theme dictionary
 * 2. Project config custom classes (if resolved)
 * 3. Arbitrary-value grammar (`prefix-[...]`)
 * 4. Variant prefix stripping + retry against all of the above
 *
 * Fail-open: if project config resolution is requested but fails, the
 * expander enters fail-open mode where project-config tier is silently
 * empty. The CALLER is responsible for emitting the visible warning and
 * potentially disabling the undefined-class detector.
 */
export class TailwindUtilityExpander {
  private bundled: Set<string> | null = null;
  private projectClasses: Set<string> | null = null;
  private _configFailed = false;
  private _configFailureReason: string | null = null;

  /**
   * Initialize the expander with optional project config.
   * Call once at the start of a project audit.
   */
  init(config: TailwindExpanderConfig = {}): void {
    this.bundled = getBundledUtilityClasses();

    if (config.customClasses) {
      this.projectClasses = new Set(config.customClasses);
      return;
    }

    if (config.useProjectConfig && config.projectRoot) {
      try {
        const result = loadTailwindConfig(config.projectRoot);
        if (result && result.tokens) {
          this.projectClasses = new Set<string>();
          // Generate utility classes from project-specific theme tokens
          const colorPrefixes = ['bg', 'text', 'border', 'ring', 'shadow', 'fill', 'stroke', 'accent', 'caret'];
          for (const colorName of Object.keys(result.tokens.colors)) {
            for (const prefix of colorPrefixes) {
              this.projectClasses.add(`${prefix}-${colorName}`);
            }
          }
          for (const spaceName of Object.keys(result.tokens.spacing)) {
            for (const prefix of [
              'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl',
              'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml',
              'w', 'h', 'min-w', 'min-h', 'max-w', 'max-h',
              'gap', 'gap-x', 'gap-y', 'space-x', 'space-y',
              'top', 'right', 'bottom', 'left', 'inset',
              'inset-x', 'inset-y',
              'leading', 'indent',
            ]) {
              this.projectClasses.add(`${prefix}-${spaceName}`);
            }
          }
          for (const sizeName of Object.keys(result.tokens.fontSize)) {
            this.projectClasses.add(`text-${sizeName}`);
          }
          for (const radiusName of Object.keys(result.tokens.borderRadius)) {
            this.projectClasses.add(`rounded-${radiusName}`);
          }
        }
      } catch (err) {
        this._configFailed = true;
        this._configFailureReason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  /** Did the project config resolution fail? */
  get configFailed(): boolean {
    return this._configFailed;
  }

  /** Why did project config resolution fail? */
  get configFailureReason(): string | null {
    return this._configFailureReason;
  }

  /**
   * Resolve a single class name against the expansion path.
   * Returns the highest-priority matching tier, or 'none'.
   */
  resolve(className: string): UtilityClassResolution {
    const bundled = this.bundled ?? getBundledUtilityClasses();

    // 1. Check raw class against bundled dictionary
    if (bundled.has(className)) {
      return { valid: true, tier: 'bundled' };
    }

    // 2. Check raw class against project config
    if (this.projectClasses?.has(className)) {
      return { valid: true, tier: 'project-config' };
    }

    // 3. Check opacity-modifier syntax: {color-utility}/{opacity}
    if (className.includes('/')) {
      const result = this.checkOpacityModifier(className);
      if (result) return result;
    }

    // 4. Check arbitrary-value grammar: prefix-[...]
    if (this.matchesArbitraryValue(className)) {
      return { valid: true, tier: 'arbitrary-value' };
    }

    // 5. Check negative-value utility: -{prefix}-{value}
    const negResult = this.checkNegativeUtility(className);
    if (negResult) return negResult;

    // 6. Strip variant prefix and retry
    const stripped = this.stripVariantPrefix(className);
    if (stripped !== className) {
      return this.resolve(stripped); // Recurse once with the stripped class
    }

    return { valid: false, tier: 'none' };
  }

  /**
   * Check whether a class matches the arbitrary-value grammar:
   * `{known-prefix}-[...]`
   */
  private matchesArbitraryValue(className: string): boolean {
    const bracketIdx = className.indexOf('[');
    if (bracketIdx <= 0) return false;

    // Extract the prefix before the [
    const prefix = className.substring(0, bracketIdx);
    // Handle prefix-[value] where prefix ends with '-'
    if (prefix.endsWith('-')) {
      const normalizedPrefix = prefix.slice(0, -1);
      return ARBITRARY_VALUE_PREFIXES.has(normalizedPrefix);
    }

    return false;
  }

  /**
   * Check the opacity-modifier syntax: `{utility}/{opacity}`.
   * e.g., `bg-red-500/50` → `bg-red-500` must be a valid utility AND
   * `50` must be a valid opacity value.
   *
   * We split on the LAST `/` to avoid confusing fractional widths
   * (e.g. `w-1/2`) — those are in the dictionary directly and won't
   * reach this check.
   */
  private checkOpacityModifier(
    className: string,
  ): UtilityClassResolution | null {
    const lastSlash = className.lastIndexOf('/');
    if (lastSlash <= 0) return null;

    const prefix = className.substring(0, lastSlash);
    const suffix = className.substring(lastSlash + 1);

    // Suffix must be a numeric opacity value (0-100)
    if (!/^\d{1,3}$/.test(suffix)) return null;
    const opacity = parseInt(suffix, 10);
    if (opacity < 0 || opacity > 100) return null;

    // Prefix must be a known utility
    const bundled = this.bundled ?? getBundledUtilityClasses();
    if (bundled.has(prefix) || this.projectClasses?.has(prefix)) {
      return { valid: true, tier: 'project-config' };
    }

    return null;
  }

  /**
   * Check a negative utility: `-{prefix}-{value}`.
   * e.g., `-mt-1`, `-top-2`, `-translate-x-1/2`, `-z-10`.
   *
   * Strips the leading `-` and checks whether the remainder is a valid
   * utility whose prefix is in the negative-allowed set.
   */
  private checkNegativeUtility(
    className: string,
  ): UtilityClassResolution | null {
    if (!className.startsWith('-')) return null;

    const positive = className.slice(1); // strip leading '-'

    // Determine the prefix of the positive utility
    // e.g., "top-2" → prefix="top", "translate-x-1/2" → prefix="translate-x"
    const lastDash = positive.lastIndexOf('-');
    const prefix = lastDash > 0 ? positive.substring(0, lastDash) : positive;

    if (!NEGATIVE_ALLOWED_PREFIXES.has(prefix)) return null;

    // Recurse: is the positive utility itself valid?
    const result = this.resolve(positive);
    if (result.valid) {
      return { valid: true, tier: result.tier };
    }

    return null;
  }

  /**
   * Strip a Tailwind variant prefix from a class name.
   * E.g., "hover:bg-blue-500" → "bg-blue-500"
   * Returns the original if no variant prefix is matched.
   */
  stripVariantPrefix(className: string): string {
    for (const prefix of VARIANT_PREFIXES) {
      if (className.startsWith(prefix + ':')) {
        return className.slice(prefix.length + 1);
      }
    }
    return className;
  }

  /**
   * Check if a class has a variant prefix at all.
   */
  hasVariantPrefix(className: string): boolean {
    return className.includes(':') && this.stripVariantPrefix(className) !== className;
  }

  /** Reset state (useful for testing). */
  reset(): void {
    this.bundled = null;
    this.projectClasses = null;
    this._configFailed = false;
    this._configFailureReason = null;
  }
}

/** Singleton instance for the analyzer layer. */
let _instance: TailwindUtilityExpander | null = null;

export function getTailwindExpander(): TailwindUtilityExpander {
  if (!_instance) {
    _instance = new TailwindUtilityExpander();
  }
  return _instance;
}

export function resetTailwindExpander(): void {
  _instance = null;
}
