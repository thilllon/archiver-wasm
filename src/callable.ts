// src/callable.ts  (scaffold unit, verbatim)
/** Makes an ES class callable without `new` (upstream: `if (!(this instanceof X)) return new X(options)`). */
export function callable<A extends unknown[], T extends object>(
  cls: new (...args: A) => T,
): (new (...args: A) => T) & ((...args: A) => T) {
  const proxy = new Proxy(cls, {
    apply: (target, _thisArg, args) => new target(...(args as A)),
  }) as unknown as (new (...args: A) => T) & ((...args: A) => T);
  // class XImpl is published as X (7.9): X.name and instance.constructor are upstream's
  Object.defineProperty(cls, 'name', { value: cls.name.replace(/Impl$/, ''), configurable: true });
  Object.defineProperty(cls.prototype, 'constructor', { value: proxy, writable: true, configurable: true });
  return proxy;
}
