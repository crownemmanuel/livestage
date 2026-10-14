/** Dev-only: hide named render parts from the console (window.__slsHide.add("mountains")). */
export const debugHidden: Set<string> = (() => {
  const w = window as unknown as { __slsHide?: Set<string> };
  w.__slsHide ??= new Set<string>();
  return w.__slsHide;
})();
