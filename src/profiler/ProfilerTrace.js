// WITH_GENESYS
export const TRACE_TID_MAIN = 1;
export const TRACE_TID_ASYNC = 2;
export const TRACE_TID_GPU = 3;

const TRACE_TID_ASYNC_OVERFLOW = 100;
const INITIAL_CAPACITY = 4096;

/**
 * Complete trace slices stored in columns, so recording a slice allocates nothing but the
 * occasional column growth. Chrome trace events are only built on export.
 */
class TraceBuffer {

	constructor() {

		this.length = 0;
		this._allocate( 0 );

	}

	clear() {

		this.length = 0;
		this._allocate( 0 );

	}

	/**
	 * @param {string} name
	 * @param {number} ts Start (µs).
	 * @param {number} dur Duration (µs), greater than zero.
	 * @param {number} tid
	 * @param {number} depth Nesting depth; orders slices that cover the same range.
	 */
	push( name, ts, dur, tid, depth ) {

		const i = this.length;
		if ( i === this.ts.length ) this._grow();

		this.names[ i ] = name;
		this.ts[ i ] = ts;
		this.dur[ i ] = dur;
		this.tid[ i ] = tid;
		this.depth[ i ] = depth;
		this.length = i + 1;

	}

	_allocate( capacity ) {

		this.names = [];
		this.ts = new Float64Array( capacity );
		this.dur = new Float64Array( capacity );
		this.tid = new Uint8Array( capacity );
		this.depth = new Uint32Array( capacity );

	}

	_grow() {

		const { names, ts, dur, tid, depth } = this;
		this._allocate( Math.max( INITIAL_CAPACITY, ts.length * 2 ) );
		this.names = names;
		this.ts.set( ts );
		this.dur.set( dur );
		this.tid.set( tid );
		this.depth.set( depth );

	}

}

/**
 * @param {TraceBuffer} trace
 * @param {number} minDurUs Omit slices shorter than this duration (µs).
 * @return {import('./ProfilerService.js').ChromeTrace}
 */
function buildChromeTrace( trace, minDurUs ) {

	const { names, ts, dur, tid, depth } = trace;
	const order = [];
	for ( let i = 0; i < trace.length; i ++ ) {

		if ( dur[ i ] >= minDurUs ) order.push( i );

	}

	// Viewers nest slices that cover the same range in file order, so enclosing slices
	// (lower depth, then longer) come first.
	order.sort( ( a, b ) => ts[ a ] - ts[ b ] || tid[ a ] - tid[ b ] || depth[ a ] - depth[ b ] || dur[ b ] - dur[ a ] || a - b );

	const slices = order.map( i => ( {
		name: names[ i ],
		ph: 'X',
		ts: ts[ i ],
		dur: dur[ i ],
		pid: 1,
		tid: tid[ i ],
		cat: tid[ i ] === TRACE_TID_GPU ? 'gnsx-gpu' : 'gnsx',
		args: { depth: depth[ i ] },
	} ) );
	const asyncRowCount = assignAsyncRows( slices );

	const prefix = [
		metadata( 'process_name', 0, 'Genesys Profiler' ),
		metadata( 'thread_name', TRACE_TID_MAIN, 'Main thread' ),
	];
	for ( let row = 0; row < asyncRowCount; row ++ ) {

		prefix.push( row === 0
			? metadata( 'thread_name', TRACE_TID_ASYNC, 'Async (promise lifetime)' )
			: metadata( 'thread_name', TRACE_TID_ASYNC_OVERFLOW + row, `Async (promise lifetime) ${row + 1}` ) );

	}

	if ( slices.some( event => event.tid === TRACE_TID_GPU ) ) {

		prefix.push( metadata( 'thread_name', TRACE_TID_GPU, 'GPU (device timestamps)' ) );

	}

	return {
		displayTimeUnit: 'ms',
		traceEvents: [ ...prefix, ...slices ],
	};

}

/**
 * @param {'process_name'|'thread_name'} name
 * @param {number} tid
 * @param {string} label
 * @return {import('./ProfilerService.js').ChromeTraceMetadataEvent}
 */
function metadata( name, tid, label ) {

	return { cat: '__metadata', name, ph: 'M', pid: 1, tid, ts: 0, args: { name: label } };

}

/**
 * Promise lifetimes overlap freely, but complete events on one thread must nest. Moves each
 * async slice onto the first row where it nests or follows. Expects `slices` sorted by start,
 * longer first.
 *
 * @param {import('./ProfilerService.js').ChromeTraceEvent[]} slices
 * @return {number} Number of async rows used.
 */
function assignAsyncRows( slices ) {

	/** @type {number[][]} Open slice end times per row (innermost last). */
	const rows = [];

	for ( const event of slices ) {

		if ( event.tid !== TRACE_TID_ASYNC ) continue;

		const end = event.ts + event.dur;
		let row = 0;
		for ( ; row < rows.length; row ++ ) {

			const open = rows[ row ];
			while ( open.length > 0 && open[ open.length - 1 ] <= event.ts ) open.pop();
			if ( open.length === 0 || end <= open[ open.length - 1 ] ) break;

		}

		if ( row === rows.length ) rows.push( [] );
		rows[ row ].push( end );
		if ( row > 0 ) event.tid = TRACE_TID_ASYNC_OVERFLOW + row;

	}

	return rows.length;

}

export { TraceBuffer, buildChromeTrace };
// !WITH_GENESYS
