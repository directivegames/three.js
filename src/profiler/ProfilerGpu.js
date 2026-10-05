// WITH_GENESYS
import { TimestampQuery } from '../constants.js';
import { warnOnce } from '../utils.js';

const FLUSH_MAX_ATTEMPTS = 3;
const UNLABELED_PASS = 'GPU pass: (unlabeled)';
const UNLABELED_SPAN = '(unlabeled)';
const DROPPED_SPANS_WARNING = 'ProfilerService: Dropped GPU spans whose timestamps never resolved; another consumer of resolveTimestampsAsync() (e.g. the Inspector) may be taking them.';

export const DUMMY_GPU_SPAN = Object.freeze( { label: '', renderer: null, t0: 0, _seq: 0, _generation: 0 } );

/**
 * @param {function(): void} callback
 */
function onNextFrame( callback ) {

	if ( typeof requestAnimationFrame === 'function' ) requestAnimationFrame( callback );
	else setTimeout( callback, 4 );

}

/**
 * GPU timing for one renderer. Results resolve asynchronously, so ended spans queue until a
 * flush, which runs on the next animation frame or through `flushGpu()`.
 */
class GpuTimer {

	/**
	 * @param {import('./ProfilerService.js').ProfilerServiceClass} profiler
	 * @param {Object} renderer
	 * @param {boolean} available
	 */
	constructor( profiler, renderer, available ) {

		this.profiler = profiler;
		this.renderer = renderer;
		this.available = available;
		this._flushPromise = null;
		this._flushScheduled = false;
		this._detached = false;

	}

	/**
	 * Concurrent calls share one flush.
	 *
	 * @return {Promise<void>}
	 */
	flush() {

		if ( this._flushPromise === null ) {

			this._flushPromise = this._flush().finally( () => {

				this._flushPromise = null;
				if ( this._hasPending() ) this.scheduleFlush();

			} );

		}

		return this._flushPromise;

	}

	scheduleFlush() {

		if ( this._flushScheduled ) return;
		this._flushScheduled = true;

		onNextFrame( () => {

			this._flushScheduled = false;
			if ( this._detached ) return;

			this.flush().catch( error => {

				warnOnce( `ProfilerService: Unable to resolve GPU timestamps (${error.message}).` );

			} );

		} );

	}

	detach() {

		this._detached = true;

	}

	/**
	 * @param {string} label
	 * @return {Object} An identity object for the span (start `t0`, `_seq`, `_generation`).
	 */
	_createHandle( label ) {

		return {
			label,
			renderer: this.renderer,
			t0: performance.now(),
			_seq: ++ this.profiler._seq,
			_generation: this.profiler._generation,
		};

	}

}

/**
 * Common `Renderer` (WebGPU and its WebGL fallback). The backend reports every timestamp query
 * it allocates; each query goes into a log in allocation order, and a span covers the queries
 * reported while it was open, i.e. a range of log indices. The log is cut into a batch only
 * while no span is open, so every span lies inside one batch.
 */
class WebGPUTimer extends GpuTimer {

	/**
	 * @param {import('./ProfilerService.js').ProfilerServiceClass} profiler
	 * @param {Object} renderer
	 * @param {boolean} available
	 */
	constructor( profiler, renderer, available ) {

		super( profiler, renderer, available );

		this._listener = ( type, uid, label, parentUid ) => this._onQuery( type, uid, label, parentUid );
		this._previousTrackTimestamp = renderer.backend.trackTimestamp;
		this._previousPassTimestampLevel = renderer.backend.passTimestampLevel;
		/** @type {GpuQuery[]} Queries reported since the last cut. */
		this._queries = [];
		/** @type {Map<string, number>} Log index per uid since the last cut. */
		this._queryIndex = new Map();
		this._openSpans = [];
		this._closedSpans = [];
		/** @type {Array<{ queries: GpuQuery[], spans: Object[], attempts: number }>} */
		this._batches = [];
		/** GPU timestamp (ns) and CPU time (ms) of the first resolved query, which align the clocks. */
		this._gpuOrigin = null;
		this._cpuOrigin = 0;

		if ( available ) {

			renderer.backend.trackTimestamp = true;
			renderer.backend.addTimestampQueryListener( this._listener );

		}

		this.setPassTimestampLevel( profiler._passTimestampLevel );

	}

	/**
	 * Whether the renderer can time stages and draws inside passes.
	 *
	 * @type {boolean}
	 */
	get supportsPassTimestamps() {

		return this.available && this.renderer.backend.supportsPassTimestamps === true;

	}

	/**
	 * @param {number} level A {@link PassTimestampLevel}; ignored without in-pass timestamp support.
	 */
	setPassTimestampLevel( level ) {

		if ( this.supportsPassTimestamps ) this.renderer.backend.passTimestampLevel = level;

	}

	begin( label ) {

		const handle = this._createHandle( label );
		handle._first = this._queries.length;
		handle._end = - 1;
		handle._depth = this._openSpans.length;
		this._openSpans.push( handle );
		return handle;

	}

	end( handle ) {

		const index = this._openSpans.lastIndexOf( handle );
		if ( index === - 1 ) return;

		this._openSpans.splice( index, 1 );
		handle._end = this._queries.length;
		if ( handle._end > handle._first ) this._closedSpans.push( handle );
		if ( this._openSpans.length === 0 && this._queries.length > 0 ) this.scheduleFlush();

	}

	clear() {

		this._queries = [];
		this._queryIndex.clear();
		this._openSpans.length = 0;
		this._closedSpans = [];
		this._batches.length = 0;
		this._gpuOrigin = null;

	}

	detach() {

		super.detach();
		if ( this.available === false ) return;

		this.renderer.backend.removeTimestampQueryListener( this._listener );
		this.renderer.backend.trackTimestamp = this._previousTrackTimestamp;
		if ( this.renderer.backend.supportsPassTimestamps === true ) this.renderer.backend.passTimestampLevel = this._previousPassTimestampLevel;

	}

	/**
	 * @param {'render'|'compute'} type
	 * @param {string} uid
	 * @param {?string} label
	 * @param {?string} [parentUid=null] Pass or pass timestamp span the query is nested in.
	 */
	_onQuery( type, uid, label, parentUid = null ) {

		const hasLabel = label !== null && label !== undefined && label !== '';

		// The backend notifies once per query allocation, so a restarted pass reports its uid
		// again; the pool already accumulates that uid's full duration.
		if ( this._queryIndex.has( uid ) ) return;

		if ( parentUid !== null && parentUid !== undefined ) {

			// A nested span only means something inside its pass, so it goes when the pass does.
			const parentIndex = this._queryIndex.get( parentUid );
			if ( parentIndex === undefined ) return;

			const parent = this._queries[ parentIndex ];
			const name = hasLabel ? label : UNLABELED_SPAN;
			this._pushQuery( uid, type, name, `${ parent.statsLabel } / ${ name }`, hasLabel, parent.depth + 1, parent );
			return;

		}

		const depth = this._openSpans.length;
		if ( depth === 0 && hasLabel === false ) return;

		const name = hasLabel ? `GPU pass: ${label}` : UNLABELED_PASS;
		this._pushQuery( uid, type, name, name, hasLabel, depth, null );

		if ( depth === 0 ) this.scheduleFlush();

	}

	/**
	 * @param {string} uid
	 * @param {'render'|'compute'} type
	 * @param {string} label
	 * @param {string} statsLabel
	 * @param {boolean} labelled
	 * @param {number} depth
	 * @param {?GpuQuery} parent
	 */
	_pushQuery( uid, type, label, statsLabel, labelled, depth, parent ) {

		this._queryIndex.set( uid, this._queries.length );
		this._queries.push( {
			uid,
			type,
			label,
			statsLabel,
			labelled,
			cpuTime: performance.now(),
			depth,
			parent,
			duration: NaN,
			range: null,
		} );

	}

	_hasPending() {

		return this._batches.length > 0 || ( this._queries.length > 0 && this._openSpans.length === 0 );

	}

	async _flush() {

		if ( this._openSpans.length === 0 && this._queries.length > 0 ) {

			this._batches.push( { queries: this._queries, spans: this._closedSpans, attempts: 0 } );
			this._queries = [];
			this._queryIndex.clear();
			this._closedSpans = [];

		}

		const batches = this._batches.splice( 0 );
		if ( batches.length === 0 ) return;

		if ( this.renderer.backend.trackTimestamp !== true ) {

			warnOnce( 'ProfilerService: Timestamp tracking was turned off on an attached renderer (e.g. by the Inspector); GPU timings will stop.' );

		}

		const types = new Set();
		for ( const batch of batches ) {

			for ( const query of batch.queries ) types.add( query.type );

		}

		const generation = this.profiler._generation;
		await Promise.all( [ TimestampQuery.RENDER, TimestampQuery.COMPUTE ]
			.filter( type => types.has( type ) )
			.map( type => this.renderer.resolveTimestampsAsync( type ) ) );

		if ( this.profiler._enabled === false || this.profiler._generation !== generation ) return;

		for ( const batch of batches ) this._commitBatch( batch );

	}

	/**
	 * @param {{ queries: GpuQuery[], spans: Object[], attempts: number }} batch
	 */
	_commitBatch( batch ) {

		const backend = this.renderer.backend;
		const { queries, spans } = batch;

		// Each resolve replaces the pool's timestamps with that resolve's queries, so a retry
		// must keep what earlier attempts read.
		let resolved = 0;
		for ( const query of queries ) {

			if ( Number.isNaN( query.duration ) && backend.hasTimestampQuery( query.uid ) ) {

				query.duration = backend.getTimestamp( query.uid );
				query.range = backend.getTimestampRange( query.uid );

			}

			if ( Number.isNaN( query.duration ) === false ) resolved ++;

		}

		// The pool can skip a resolve (e.g. its result buffer is still mapped), so wait a few
		// flushes for the missing timestamps.
		if ( resolved < queries.length && ++ batch.attempts < FLUSH_MAX_ATTEMPTS ) {

			this._batches.push( batch );
			return;

		}

		if ( resolved === 0 ) {

			warnOnce( DROPPED_SPANS_WARNING );
			return;

		}

		if ( this._gpuOrigin === null ) this._setOrigin( queries );

		const passes = this._placePasses( queries );
		this._snapPasses( passes );

		for ( const query of passes ) {

			this.profiler._commitGpuSample( query.statsLabel, query.duration, query.traceTs, query.traceDur, query.depth, query.label );

		}

		let dropped = false;
		for ( const span of spans ) {

			if ( this._commitSpan( span, queries ) === false ) dropped = true;

		}

		if ( dropped ) warnOnce( DROPPED_SPANS_WARNING );

	}

	/**
	 * @param {GpuQuery[]} queries
	 */
	_setOrigin( queries ) {

		let earliest = null;
		for ( const query of queries ) {

			if ( query.range !== null && ( earliest === null || query.range.start < earliest.range.start ) ) earliest = query;

		}

		if ( earliest === null ) return;

		this._gpuOrigin = earliest.range.start;
		this._cpuOrigin = earliest.cpuTime;

	}

	/**
	 * Places each pass on the CPU timeline (µs): by its GPU timestamps when the backend has
	 * them, else at the CPU time it was reported. Unlabeled queries without a range would only
	 * guess a position, so they are not passes. Nested spans without a range keep their stats
	 * but stay out of the trace.
	 *
	 * @param {GpuQuery[]} queries
	 * @return {GpuQuery[]} Resolved passes.
	 */
	_placePasses( queries ) {

		const passes = [];

		for ( const query of queries ) {

			query.traceTs = 0;
			query.traceDur = 0;
			if ( Number.isNaN( query.duration ) ) continue;

			const ranged = query.range !== null && this._gpuOrigin !== null;
			if ( ranged === false && query.parent !== null ) {

				passes.push( query );
				continue;

			}

			if ( ranged === false && query.labelled === false ) continue;

			const start = ranged ? this._gpuTimeToCpu( query.range.start ) : query.cpuTime;
			const end = ranged ? this._gpuTimeToCpu( query.range.end ) : query.cpuTime + query.duration;
			query.traceTs = Math.round( this.profiler._toTraceUs( start ) );
			query.traceDur = Math.round( this.profiler._toTraceUs( end ) ) - query.traceTs;
			passes.push( query );

		}

		return passes;

	}

	/**
	 * Converts traced passes to non-overlapping half-open µs intervals, so they stack on one
	 * row. Nested spans keep their measured times clipped to their parent's snapped interval;
	 * one that falls outside it is left out of the trace. Stats keep the measured durations.
	 *
	 * @param {GpuQuery[]} passes
	 */
	_snapPasses( passes ) {

		const roots = [];
		const children = new Map();

		for ( const query of passes ) {

			if ( query.parent === null ) {

				if ( query.traceDur > 0 ) roots.push( query );
				continue;

			}

			let siblings = children.get( query.parent );
			if ( siblings === undefined ) children.set( query.parent, siblings = [] );
			siblings.push( query );

		}

		this._snapSiblings( roots, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY );

		// Parents are shallower than their children, so they are final before their children snap.
		const groups = [ ...children ].sort( ( a, b ) => a[ 0 ].depth - b[ 0 ].depth );
		for ( const [ parent, siblings ] of groups ) {

			if ( parent.traceDur <= 0 ) {

				for ( const query of siblings ) query.traceDur = 0;
				continue;

			}

			const traced = siblings.filter( query => query.traceDur > 0 );
			this._snapSiblings( traced, parent.traceTs, parent.traceTs + parent.traceDur );

		}

	}

	/**
	 * Snaps sibling slices to non-overlapping intervals within `[start, end)`.
	 *
	 * @param {GpuQuery[]} siblings Traced queries (`traceDur > 0`).
	 * @param {number} start
	 * @param {number} end
	 */
	_snapSiblings( siblings, start, end ) {

		// Longer first at the same timestamp so the substantial pass keeps its start.
		siblings.sort( ( a, b ) => a.traceTs - b.traceTs || b.traceDur - a.traceDur );

		let cursor = start;
		for ( const query of siblings ) {

			let ts = query.traceTs;
			let queryEnd = ts + query.traceDur;
			if ( queryEnd <= start || ts >= end ) {

				query.traceDur = 0;
				continue;

			}

			if ( ts < cursor ) {

				queryEnd = Math.max( queryEnd, cursor + 1 );
				ts = cursor;

			}

			if ( ts >= end ) {

				query.traceDur = 0;
				continue;

			}

			query.traceTs = ts;
			query.traceDur = Math.max( 1, Math.min( queryEnd, end ) - ts );
			cursor = ts + query.traceDur;

		}

	}

	/**
	 * Stats use the summed busy time of the span's queries. The trace slice covers exactly its
	 * snapped passes, so sibling spans never partially overlap and every pass nests inside.
	 *
	 * @param {Object} span
	 * @param {GpuQuery[]} queries
	 * @return {boolean} False when none of the span's queries resolved.
	 */
	_commitSpan( span, queries ) {

		let busy = 0;
		let resolved = 0;
		let minTs = Infinity;
		let maxEnd = - Infinity;

		for ( let i = span._first; i < span._end; i ++ ) {

			const query = queries[ i ];
			// Nested spans are already inside their pass's time.
			if ( query.parent !== null || Number.isNaN( query.duration ) ) continue;

			busy += query.duration;
			resolved ++;
			if ( query.traceDur > 0 ) {

				minTs = Math.min( minTs, query.traceTs );
				maxEnd = Math.max( maxEnd, query.traceTs + query.traceDur );

			}

		}

		if ( resolved === 0 ) return false;

		if ( minTs === Infinity ) {

			minTs = Math.round( this.profiler._toTraceUs( span.t0 ) );
			maxEnd = Math.round( this.profiler._toTraceUs( span.t0 + busy ) );

		}

		this.profiler._commitGpuSample( span.label, busy, minTs, maxEnd - minTs, span._depth );
		return true;

	}

	/**
	 * @param {bigint} gpuTime Nanoseconds.
	 * @return {number} CPU time (ms).
	 */
	_gpuTimeToCpu( gpuTime ) {

		return this._cpuOrigin + Number( gpuTime - this._gpuOrigin ) / 1e6;

	}

}

/**
 * Legacy `WebGLRenderer` through `EXT_disjoint_timer_query_webgl2`: one `TIME_ELAPSED` query
 * per span, so spans cannot nest.
 */
class WebGLTimer extends GpuTimer {

	/**
	 * @param {import('./ProfilerService.js').ProfilerServiceClass} profiler
	 * @param {Object} renderer
	 */
	constructor( profiler, renderer ) {

		const gl = renderer.getContext();
		const extension = gl.getExtension( 'EXT_disjoint_timer_query_webgl2' );
		super( profiler, renderer, extension !== null );

		this.gl = gl;
		this.extension = extension;
		this._active = null;
		this._pending = [];

		if ( extension === null ) {

			warnOnce( 'ProfilerService: EXT_disjoint_timer_query_webgl2 is unavailable; GPU profiling is disabled for this WebGLRenderer.' );

		}

	}

	begin( label ) {

		if ( this._active !== null ) {

			warnOnce( 'ProfilerService: Nested GPU spans are unsupported by legacy WebGLRenderer.' );
			return DUMMY_GPU_SPAN;

		}

		const query = this.gl.createQuery();
		if ( query === null ) return DUMMY_GPU_SPAN;

		try {

			this.gl.beginQuery( this.extension.TIME_ELAPSED_EXT, query );

		} catch ( error ) {

			this.gl.deleteQuery( query );
			warnOnce( `ProfilerService: Unable to begin a WebGL GPU span (${error.message}).` );
			return DUMMY_GPU_SPAN;

		}

		const handle = this._createHandle( label );
		handle._query = query;
		this._active = handle;
		return handle;

	}

	end( handle ) {

		if ( this._active !== handle ) return;
		this._active = null;

		try {

			this.gl.endQuery( this.extension.TIME_ELAPSED_EXT );
			this._pending.push( handle );
			this.scheduleFlush();

		} catch ( error ) {

			this.gl.deleteQuery( handle._query );
			warnOnce( `ProfilerService: Unable to end a WebGL GPU span (${error.message}).` );

		}

	}

	clear() {

		if ( this._active !== null ) {

			try {

				this.gl.endQuery( this.extension.TIME_ELAPSED_EXT );

			} catch {

				// The context may have been lost while the query was active.

			}

			this.gl.deleteQuery( this._active._query );
			this._active = null;

		}

		// An in-flight flush has already taken its own spans and deletes their queries itself.
		for ( const span of this._pending ) this.gl.deleteQuery( span._query );
		this._pending.length = 0;

	}

	_hasPending() {

		return this._pending.length > 0;

	}

	async _flush() {

		const spans = this._pending.splice( 0 );

		for ( const span of spans ) {

			if ( span._generation !== this.profiler._generation ) {

				this.gl.deleteQuery( span._query );
				continue;

			}

			const duration = await this._resolveQuery( span._query );
			if ( duration === null || span._generation !== this.profiler._generation || this.profiler._enabled === false ) continue;

			const ts = Math.round( this.profiler._toTraceUs( span.t0 ) );
			const dur = Math.round( this.profiler._toTraceUs( span.t0 + duration ) ) - ts;
			this.profiler._commitGpuSample( span.label, duration, ts, dur, 0 );

		}

	}

	/**
	 * Polls once per animation frame and deletes the query. Never rejects: errors and disjoint
	 * events resolve `null`.
	 *
	 * @param {WebGLQuery} query
	 * @return {Promise<?number>} Elapsed time (ms).
	 */
	_resolveQuery( query ) {

		return new Promise( resolve => {

			const gl = this.gl;
			// Reading GPU_DISJOINT_EXT clears it, so a disjoint seen on any poll must stick.
			let disjoint = false;

			const finish = result => {

				try {

					gl.deleteQuery( query );

				} catch {

					// Deleting a query on a lost context is harmless to skip.

				}

				resolve( result );

			};

			const poll = () => {

				try {

					if ( gl.isContextLost() ) {

						finish( null );
						return;

					}

					if ( gl.getParameter( this.extension.GPU_DISJOINT_EXT ) ) disjoint = true;

					if ( gl.getQueryParameter( query, gl.QUERY_RESULT_AVAILABLE ) === false ) {

						onNextFrame( poll );
						return;

					}

					finish( disjoint ? null : Number( gl.getQueryParameter( query, gl.QUERY_RESULT ) ) / 1e6 );

				} catch ( error ) {

					warnOnce( `ProfilerService: Unable to read a WebGL GPU timer query (${error.message}).` );
					finish( null );

				}

			};

			poll();

		} );

	}

}

/**
 * @typedef {Object} GpuQuery
 * @property {string} uid
 * @property {'render'|'compute'} type
 * @property {string} label Trace name: `GPU pass: …` for passes, the span label for nested spans.
 * @property {string} statsLabel Stats key; nested spans are `{parent statsLabel} / {label}`.
 * @property {boolean} labelled Whether the backend reported a label.
 * @property {number} cpuTime When the query was reported (ms).
 * @property {number} depth GPU spans open when it was reported, or parent depth + 1 when nested.
 * @property {?GpuQuery} parent Pass or span this one was timed inside.
 * @property {number} duration Resolved GPU time (ms), or `NaN` until resolved.
 * @property {?{ start: bigint, end: bigint }} range
 * @property {number} [traceTs]
 * @property {number} [traceDur] */

export { WebGPUTimer, WebGLTimer };
// !WITH_GENESYS
