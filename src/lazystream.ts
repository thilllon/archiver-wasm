import { PassThrough } from 'node:stream';

// Patch the given method of instance so that the callback
// is executed once, before the actual method is called the
// first time.
// node-archiver/node_modules/lazystream/lib/lazystream.js:15
function beforeFirstCall(instance: Readable, method: '_read', callback: (this: Readable, ...args: Parameters<Readable['_read']>) => void) {
  instance[method] = function(this: Readable) {
    delete (instance as { _read?: unknown })[method];
    callback.apply(this, arguments as unknown as Parameters<Readable['_read']>);
    return this[method].apply(this, arguments as unknown as Parameters<Readable['_read']>);
  };
}

// node-archiver/node_modules/lazystream/lib/lazystream.js:23
export class Readable extends PassThrough {
  constructor(fn: () => NodeJS.ReadableStream) {
    super({ autoDestroy: false, emitClose: false });   // PORTING.md V9

    beforeFirstCall(this, '_read', function() {
      var source = fn.call(this);
      var emit = this.emit.bind(this, 'error');
      source.on('error', emit);
      source.pipe(this);
    });

    this.emit('readable');
  }
}
