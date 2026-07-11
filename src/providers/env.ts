// Shared truthy-env parsing so provider feature flags don't drift in the
// vocabularies they accept — a recurring footgun when each flag hand-rolls its
// own `v.toLowerCase()` dance (one sibling accepting `yes` while another
// silently ignores it). A flag is ON for 1/true/yes/on (case-insensitive) and
// OFF for anything else, including unset or empty.
export const boolFromEnv = (name: string, fallback = false): boolean => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const norm = v.toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on';
};
