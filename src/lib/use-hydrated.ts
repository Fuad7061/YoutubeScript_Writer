import { useEffect, useState } from "react";

/** Returns true after client hydration completes. Use to guard render output
 *  that depends on browser-only state (localStorage) and would otherwise
 *  cause SSR/CSR text mismatches. */
export function useHydrated() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
