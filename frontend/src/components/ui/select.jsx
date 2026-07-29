// The house <select>. Extracted because the same literal class string was pasted into
// eleven selects on the QuickBooks page alone — and this integration's guiding rule is that
// every choice is picked from a dropdown, never typed, so there are only going to be more.
//
// A plain <select> on purpose: it is a native control, so keyboard, mobile pickers and
// screen readers all work without any of the JS a custom listbox would need.

const BASE =
  'flex w-full rounded-md border border-input bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

// `compact` matches the size the mapping/milestone rows use, where several selects share
// one line and the full-height control would crowd them.
const SIZES = {
  default: 'h-10 px-3 py-2 text-sm',
  compact: 'h-9 px-2 text-xs',
};

export function Select({ size = 'default', className = '', children, ...props }) {
  return (
    <select className={`${BASE} ${SIZES[size] ?? SIZES.default} ${className}`} {...props}>
      {children}
    </select>
  );
}

export default Select;
