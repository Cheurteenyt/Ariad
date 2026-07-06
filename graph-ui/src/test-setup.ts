// graph-ui/src/test-setup.ts
// R44 (Part C): Vitest setup — imports @testing-library/jest-dom matchers
// (toBeInTheDocument, toHaveAttribute, etc.) so tests can use them without
// importing in every file.

import "@testing-library/jest-dom/vitest";

// Mock `window.matchMedia` — some components may use it for responsive logic.
// jsdom doesn't implement it natively.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Mock `ResizeObserver` — jsdom doesn't implement it. GraphCanvas uses it
// to handle canvas resizing.
if (!global.ResizeObserver) {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

// Mock `requestAnimationFrame` — jsdom doesn't implement it. GraphCanvas
// uses rAF to batch redraws.
if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  global.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
