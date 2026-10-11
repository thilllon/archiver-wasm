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

type DLLNode<T> = { data: T; prev?: DLLNode<T> | null; next?: DLLNode<T> | null };

// node-archiver/node_modules/async/internal/DoublyLinkedList.js:10
// Simple doubly linked list (https://en.wikipedia.org/wiki/Doubly_linked_list) implementation
// used for queues. This implementation assumes that the node provided by the user can be modified
// to adjust the next and last properties. We implement only the minimal functionality
// for queue support.
class DLL<T> {
    head: DLLNode<T> | null | undefined;
    tail: DLLNode<T> | null | undefined;
    length: number;

    constructor() {
        this.head = this.tail = null;
        this.length = 0;
    }

    removeLink(node: DLLNode<T>) {
        if (node.prev) node.prev.next = node.next;else this.head = node.next;
        if (node.next) node.next.prev = node.prev;else this.tail = node.prev;

        node.prev = node.next = null;
        this.length -= 1;
        return node;
    }

    empty() {
        while (this.head) this.shift();
        return this;
    }

    insertAfter(node: DLLNode<T>, newNode: DLLNode<T>) {
        newNode.prev = node;
        newNode.next = node.next;
        if (node.next) node.next.prev = newNode;else this.tail = newNode;
        node.next = newNode;
        this.length += 1;
    }

    insertBefore(node: DLLNode<T>, newNode: DLLNode<T>) {
        newNode.prev = node.prev;
        newNode.next = node;
        if (node.prev) node.prev.next = newNode;else this.head = newNode;
        node.prev = newNode;
        this.length += 1;
    }

    unshift(node: DLLNode<T>) {
        if (this.head) this.insertBefore(this.head, node);else setInitial(this, node);
    }

    push(node: DLLNode<T>) {
        if (this.tail) this.insertAfter(this.tail, node);else setInitial(this, node);
    }

    shift() {
        return this.head && this.removeLink(this.head);
    }

    pop() {
        return this.tail && this.removeLink(this.tail);
    }

    toArray() {
        return [...this];
    }

    *[Symbol.iterator]() {
        var cur = this.head;
        while (cur) {
            yield cur.data;
            cur = cur.next;
        }
    }

    remove(testFn: (node: DLLNode<T>) => unknown) {
        var curr = this.head;
        while (curr) {
            var { next } = curr;
            if (testFn(curr)) {
                this.removeLink(curr);
            }
            curr = next;
        }
        return this;
    }
}

// node-archiver/node_modules/async/internal/DoublyLinkedList.js:88
function setInitial<T>(dll: DLL<T>, node: DLLNode<T>) {
    dll.length = 1;
    dll.head = dll.tail = node;
}

// node-archiver/node_modules/async/internal/queue.js:26
function _queue<T>(worker: (items: T[], callback: (err?: Error | null) => void) => void, concurrency: number | null | undefined, payload: number): QueueObject<T> {
    if (concurrency == null) {
        concurrency = 1;
    } else if (concurrency === 0) {
        throw new RangeError('Concurrency must not be zero');
    }

    var _worker = worker;
    var numRunning = 0;
    var _tasks = new DLL<T>();
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
            _tasks.empty();
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
