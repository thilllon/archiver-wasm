export type QueueWorker<T> = (task: T, callback: (err?: Error | null) => void) => void;
export interface QueueObject<T> {
  concurrency: number;
  push(data: T): void;
  kill(): void;
  idle(): boolean;
  drain(handler: () => void): void;
  length(): number;
  running(): number;
  process(): void;
}

// node-archiver/node_modules/async/internal/onlyOnce.js:7
function onlyOnce<A extends unknown[]>(fn: ((...args: A) => void) | null) {
    return function (this: unknown, ...args: A) {
        if (fn === null) throw new Error("Callback was already called.");
        var callFn = fn;
        fn = null;
        callFn.apply(this, args);
    };
}

// node-archiver/node_modules/async/internal/setImmediate.js:24
const _setImmediate = queueMicrotask;

// node-archiver/node_modules/async/internal/queue.js:26
function _queue<T>(worker: (items: T[], callback: (err?: Error | null) => void) => void, concurrency: number | null | undefined, payload: number): QueueObject<T> {
    if (concurrency == null) {
        concurrency = 1;
    } else if (concurrency === 0) {
        throw new RangeError('Concurrency must not be zero');
    }

    var _worker = worker;
    var numRunning = 0;
    var _tasks: Array<{ data: T }> = [];
    var drainHandlers: Array<() => void> = [];

    var processingScheduled = false;
    // node-archiver/node_modules/async/internal/queue.js:67
    function _insert(data: T) {
        var item = { data };

        _tasks.push(item);

        if (!processingScheduled) {
            processingScheduled = true;
            _setImmediate(() => {
                processingScheduled = false;
                q.process();
            });
        }
    }

    // node-archiver/node_modules/async/internal/queue.js:106
    function _createCB() {
        return function (err?: Error | null) {
            numRunning -= 1;

            if (q.idle()) {
                drainHandlers.forEach(handler => handler());
            }
            q.process();
        };
    }

    var isProcessing = false;
    var q = {
        concurrency,
        // node-archiver/node_modules/async/internal/queue.js:177
        push(data) {
            return _insert(data);
        },
        // node-archiver/node_modules/async/internal/queue.js:191
        kill() {
            drainHandlers = [];
            _tasks.length = 0;
        },
        // node-archiver/node_modules/async/internal/queue.js:212
        process() {
            // Avoid trying to start too many processing operations. This can occur
            // when callbacks resolve synchronously (#1267).
            if (isProcessing) {
                return;
            }
            isProcessing = true;
            while (numRunning < q.concurrency && _tasks.length) {
                var data: T[] = [];
                var l = _tasks.length;
                if (payload) l = Math.min(l, payload);
                for (var i = 0; i < l; i++) {
                    var node = _tasks.shift() as { data: T };
                    data.push(node.data);
                }

                numRunning += 1;

                var cb = onlyOnce(_createCB());
                _worker(data, cb);
            }
            isProcessing = false;
        },
        // node-archiver/node_modules/async/internal/queue.js:246
        length() {
            return _tasks.length;
        },
        // node-archiver/node_modules/async/internal/queue.js:249
        running() {
            return numRunning;
        },
        // node-archiver/node_modules/async/internal/queue.js:255
        idle() {
            return _tasks.length + numRunning === 0;
        }
    } as QueueObject<T>;
    // define these as fixed properties, so people get useful errors when updating
    Object.defineProperties(q, {
        drain: {
            writable: false,
            // node-archiver/node_modules/async/internal/queue.js:147
            value: (handler: () => void) => {
                drainHandlers = [];
                drainHandlers.push(handler);
            }
        }
    });
    return q;
}

// node-archiver/node_modules/async/queue.js:7
export function queue<T>(worker: QueueWorker<T>, concurrency?: number | null): QueueObject<T> {
    var _worker = worker;
    return _queue<T>((items, cb) => {
        _worker(items[0], cb);
    }, concurrency, 1);
}
