/**
 * Node.js polyfills for @mediapipe/tasks-vision's WASM loader.
 *
 * The MediaPipe WASM bundle is built for browsers: its loader (ta) checks
 * `typeof importScripts` and otherwise falls back to document.createElement —
 * neither of which exists in Node. The loader script (wasm/vision_wasm_*.js)
 * is generated in CommonJS/MODULARIZE mode and references `require`,
 * `__dirname`, `process`, etc., exporting its factory via a top-level
 * `var ModuleFactory`.
 *
 * The WASM graph also requests a WebGL2 context even with the CPU delegate.
 * @napi-rs/canvas provides no WebGL, so we supply:
 *  - global WebGLRenderingContext / WebGL2RenderingContext stub classes
 *  - a canvas whose getContext() returns a harmless Proxy for webgl/webgl2
 *    (the CPU path never actually renders through GL).
 *
 * This module must be imported BEFORE @mediapipe/tasks-vision.
 */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

globalThis.self = globalThis;
globalThis.window = globalThis;

/** A Proxy that answers any WebGL call harmlessly (CPU path never renders). */
export function makeGLProxy() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'getParameter') {
          return p => (p === 34921 ? 16 : 0); // MAX_VERTEX_ATTRIBS
        }
        if (prop === 'getExtension') return () => null;
        if (prop === 'getContextAttributes') return () => ({alpha: false, depth: false, antialias: false});
        if (prop === 'isContextLost') return () => false;
        if (typeof prop === 'symbol') return undefined;
        return noop;
      },
      set() {
        return true;
      },
    },
  );
}

class MockWebGLRenderingContext {
  constructor() {
    return makeGLProxy();
  }
}
class MockWebGL2RenderingContext {
  constructor() {
    return makeGLProxy();
  }
}
globalThis.WebGLRenderingContext = MockWebGLRenderingContext;
globalThis.WebGL2RenderingContext = MockWebGL2RenderingContext;

/**
 * Wrap a @napi-rs/canvas so getContext('webgl'/'webgl2') returns the mock
 * GL proxy instead of throwing "webgl2 is not supported".
 */
export function withMockGL(canvas) {
  const real = canvas.getContext.bind(canvas);
  canvas.getContext = (type, attrs) => {
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
      return makeGLProxy();
    }
    return real(type, attrs);
  };
  return canvas;
}

if (typeof globalThis.importScripts !== 'function') {
  // Must be SYNCHRONOUS: the bundle's loader calls importScripts() without
  // awaiting, then immediately checks self.ModuleFactory.
  globalThis.importScripts = src => {
    const file = String(src);
    const code = readFileSync(file, 'utf8');
    const localRequire = createRequire(file);
    const context = vm.createContext({
      require: localRequire,
      module: {exports: {}},
      exports: {},
      __dirname: path.dirname(file),
      __filename: file,
      process,
      global: globalThis,
      Buffer,
      console,
      URL,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      performance,
      WebGLRenderingContext: MockWebGLRenderingContext,
      WebGL2RenderingContext: MockWebGL2RenderingContext,
    });
    vm.runInContext(code, context, {filename: file});
    // The loader declares `var ModuleFactory` at top level → lands on the
    // context's global. Hoist it to the real global scope.
    const factory = context.ModuleFactory;
    if (factory) {
      globalThis.ModuleFactory = factory;
    }
  };
}
