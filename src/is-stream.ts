type StreamLike = { writable?: boolean; readable?: boolean; pipe?: unknown };

// node-archiver/node_modules/is-stream/index.js:1
export function isStream(stream: unknown): stream is NodeJS.ReadableStream | NodeJS.WritableStream {
	return stream !== null
		&& typeof stream === 'object'
		&& ((stream as StreamLike).writable || (stream as StreamLike).readable || ((stream as StreamLike).writable === undefined && (stream as StreamLike).readable === undefined))
		&& typeof (stream as StreamLike).pipe === 'function';
}
