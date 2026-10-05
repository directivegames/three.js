// WITH_GENESYS
import { TimestampQuery } from '../constants.js';
import { warnOnce } from '../utils.js';

/**
 * ProfilerService — per-label CPU timing with ring-buffer aggregation and DevTools integration.
 *
 * Quick start (browser console):
 *   __gnsx_profiler.enable()
 *   // play for a few seconds
 *   __gnsx_profiler.report()         // sorted console.table (aggregated stats)
 *   __gnsx_profiler.downloadTrace()  // download gnsx-trace.json for Speedscope / Perfetto
 *   __gnsx_profiler.downloadTrace('gnsx-trace.json', 0.05)  // omit spans < 0.05 ms
 *   __gnsx_profiler.reset()          // clear samples and trace
 *   __gnsx_profiler.disable()
 *
 * Chrome trace: `tid=1` is synchronous work; `@profile` on async methods records the
 * promise lifetime on `tid=2` so long async does not flatten the main row. Overlapping
 * promise lifetimes are exported on extra async rows (`tid=100+`) so every row nests. For
 * manual async spans, pass `{ asyncTimeline: true }` to both `beginSpan` and `endSpan` (the
 * latter in a `.finally()`). A scope or span that does not nest inside the work around it
 * (it outlives its parent, or ends before a span it encloses) is moved to the async rows as
 * `label (out of order)` with a one-time warning.
 *
 * Profiles: `'full'` keeps a Chrome trace and mirrors spans as User Timing measures for
 * DevTools; `'stats'` keeps only the per-label ring buffers.
 */

const RING_SIZE = 120;
const FRAME_BUDGET_MS = 1000 / 60;
const TRACE_TID_MAIN = 1;
const TRACE_TID_ASYNC = 2;
const TRACE_TID_GPU = 3;
const TRACE_TID_ASYNC_OVERFLOW = 100;
const MAX_TRACE_EVENTS = 500000;
const GPU_FLUSH_MAX_ATTEMPTS = 3;
const GPU_QUERY_CPU_TIME_TTL_MS = 2000;
const NOOP = () => {};

const DUMMY_SPAN = Object.freeze( { label: '', t0: 0, _seq: 0, _generation: 0 } );
const DUMMY_GPU_SPAN = Object.freeze( { label: '', renderer: null, t0: 0, _seq: 0, _generation: 0 } );
const NOOP_BEGIN_SPAN = () => DUMMY_SPAN;
const NOOP_END_SPAN = () => {};

const NOOP_BEGIN_GPU_SPAN = () => DUMMY_GPU_SPAN;

class ProfilerServiceClass {

	constructor() {

		this._profile = 'full';
		this._enabled = false;

		/** @type {Map<string, import('./ProfilerService.js').CpuLabelRecord>} Ring buffers and open scopes (one per label). */
		this.labels = new Map();
		/** @type {ChromeTraceEvent[]} */
		this.traceEvents = [];
		this.traceStartTime = 0;
		/** Trace events and User Timing measures kept per session in the `'full'` profile. */
		this.maxTraceEvents = MAX_TRACE_EVENTS;
		/** Budget that `frameBudget` percentages are computed against (ms). */
		this.frameBudgetMs = FRAME_BUDGET_MS;
		this._userTimingEntries = 0;
		this._markId = 0;

		/**
		 * Global call stack tracking nesting across all labels for exclusive-time computation.
		 * Scope frames have `seq === 0`; synchronous span frames carry the span's `_seq`.
		 * @type {Array<{ label: string, seq: number, t0: number, childTime: number }>}
		 */
		this.callStack = [];

		/** @type {Map<string, import('./ProfilerService.js').GpuLabelRecord>} GPU time ring buffers (one per label). */
		this.gpuLabels = new Map();
		/** @type {Map<Object, import('./ProfilerService.js').GpuRendererState>} */
		this.gpuRendererStates = new Map();
		/** @type {Map<Object, Promise<boolean>>} Common-renderer attaches waiting on `renderer.init()`. */
		this._gpuAttachments = new Map();
		/** Session counter: span handles from an earlier session are ignored. */
		this._generation = 1;

		this.begin = NOOP;
		this.end = NOOP;
		this.beginSpan = NOOP_BEGIN_SPAN;
		this.endSpan = NOOP_END_SPAN;
		this.beginGpu = NOOP_BEGIN_GPU_SPAN;
		this.endGpu = NOOP_END_SPAN;
		this._exposeGlobal();

	}

	/**
	 * Set the active profile. Must be called before enable() to take effect on the current session.
	 *
	 * @param {'full'|'stats'} profile
	 */
	setProfile( profile ) {

		this._profile = profile;

	}

	/**
	 * @return {'full'|'stats'}
	 */
	getProfile() {

		return this._profile;

	}

	enable() {

		this._clearState();
		this._enabled = true;
		this.begin = this._beginImpl.bind( this );
		this.end = this._endImpl.bind( this );
		this.beginSpan = this._beginSpanImpl.bind( this );
		this.endSpan = this._endSpanImpl.bind( this );
		this.beginGpu = this._beginGpuImpl.bind( this );
		this.endGpu = this._endGpuImpl.bind( this );
		console.log( `[ProfilerService] enabled (profile: ${this._profile}) — call __gnsx_profiler.report() or downloadTrace() from the console` );

	}

	disable() {

		this._clearState();
		this._enabled = false;
		this.begin = NOOP;
		this.end = NOOP;
		this.beginSpan = NOOP_BEGIN_SPAN;
		this.endSpan = NOOP_END_SPAN;
		this.beginGpu = NOOP_BEGIN_GPU_SPAN;
		this.endGpu = NOOP_END_SPAN;
		this._detachGpuRenderers();
		console.log( '[ProfilerService] disabled' );

	}

	isEnabled() {

		return this._enabled;

	}

	/**
	 * Whether a trace is being recorded, i.e. `begin()` trace names are used. Call sites
	 * should only build a trace name when this is true.
	 *
	 * @return {boolean}
	 */
	isTracing() {

		return this._enabled && this._profile === 'full';

	}

	_exposeGlobal() {

		if ( typeof window !== 'undefined' ) {

			window.__gnsx_profiler = this;

		}

	}

	/**
	 * Enables GPU timestamp collection for a renderer.
	 *
	 * @param {Object} renderer
	 * @return {Promise<boolean>} Whether GPU timestamps are available.
	 */
	attachGpuRenderer( renderer ) {

		if ( this._enabled === false || renderer === null || renderer === undefined ) return Promise.resolve( false );

		const existingState = this.gpuRendererStates.get( renderer );
		if ( existingState !== undefined ) return Promise.resolve( existingState.available );

		const pending = this._gpuAttachments.get( renderer );
		if ( pending !== undefined ) return pending;

		if ( renderer.isWebGLRenderer === true ) {

			const gl = renderer.getContext();
			const extension = gl.getExtension( 'EXT_disjoint_timer_query_webgl2' );
			const state = {
				kind: 'legacy-webgl',
				available: extension !== null,
				renderer,
				gl,
				extension,
				activeSpan: null,
				pendingSpans: [],
				flushPromise: null,
				flushScheduled: false,
			};
			this.gpuRendererStates.set( renderer, state );

			if ( extension === null ) {

				warnOnce( 'ProfilerService: EXT_disjoint_timer_query_webgl2 is unavailable; GPU profiling is disabled for this WebGLRenderer.' );

			}

			return Promise.resolve( state.available );

		}

		if ( renderer.isRenderer === true && renderer.backend !== undefined ) {

			const attaching = this._attachCommonGpuRenderer( renderer ).finally( () => {

				this._gpuAttachments.delete( renderer );

			} );
			this._gpuAttachments.set( renderer, attaching );
			return attaching;

		}

		warnOnce( 'ProfilerService: Unsupported renderer; expected Renderer or WebGLRenderer.' );
		return Promise.resolve( false );

	}

	/**
	 * @param {Object} renderer
	 * @return {Promise<boolean>}
	 */
	async _attachCommonGpuRenderer( renderer ) {

		try {

			await renderer.init();

		} catch ( error ) {

			warnOnce( `ProfilerService: Renderer initialization failed; GPU profiling is disabled (${error?.message ?? error}).` );
			return false;

		}

		// disable() may have run while init() was pending.
		if ( this._enabled === false ) return false;

		const available = renderer.backend.hasTimestamp === true && renderer.hasFeature( 'timestamp-query' ) === true;
		const listener = ( type, uid, label ) => this._captureGpuTimestampQuery( renderer, type, uid, label );
		const state = {
			kind: 'common',
			available,
			renderer,
			listener,
			previousTrackTimestamp: renderer.backend.trackTimestamp,
			activeSpans: [],
			pendingSpans: [],
			queryCpuTimes: new Map(),
			gpuTimestampOrigin: null,
			gpuTraceOrigin: null,
			flushPromise: null,
			flushScheduled: false,
		};
		this.gpuRendererStates.set( renderer, state );

		if ( available ) {

			renderer.backend.trackTimestamp = true;
			renderer.backend.addTimestampQueryListener( listener );

		} else {

			warnOnce( 'ProfilerService: Timestamp queries are unavailable; GPU profiling is disabled for this renderer.' );

		}

		return available;

	}

	/**
	 * @param {string} label
	 * @param {Object} renderer
	 * @return {import('./ProfilerService.js').GpuSpanHandle}
	 */
	_beginGpuImpl( label, renderer ) {

		const state = this.gpuRendererStates.get( renderer );
		if ( state === undefined || state.available === false ) return DUMMY_GPU_SPAN;

		const handle = {
			label,
			renderer,
			t0: performance.now(),
			_seq: ++ this._markId,
			_generation: this._generation,
		};

		if ( state.kind === 'common' ) {

			handle._queries = {
				[ TimestampQuery.RENDER ]: new Set(),
				[ TimestampQuery.COMPUTE ]: new Set(),
			};
			state.activeSpans.push( handle );
			return handle;

		}

		if ( state.activeSpan !== null ) {

			warnOnce( 'ProfilerService: Nested GPU spans are unsupported by legacy WebGLRenderer.' );
			return DUMMY_GPU_SPAN;

		}

		const query = state.gl.createQuery();
		if ( query === null ) return DUMMY_GPU_SPAN;

		try {

			state.gl.beginQuery( state.extension.TIME_ELAPSED_EXT, query );
			handle._query = query;
			state.activeSpan = handle;
			return handle;

		} catch ( error ) {

			state.gl.deleteQuery( query );
			warnOnce( `ProfilerService: Unable to begin a WebGL GPU span (${error.message}).` );
			return DUMMY_GPU_SPAN;

		}

	}

	/**
	 * @param {import('./ProfilerService.js').GpuSpanHandle} handle
	 */
	_endGpuImpl( handle ) {

		if ( handle._seq === 0 || handle._generation !== this._generation ) return;

		const state = this.gpuRendererStates.get( handle.renderer );
		if ( state === undefined || state.available === false ) return;

		if ( state.kind === 'common' ) {

			const index = state.activeSpans.indexOf( handle );
			if ( index === - 1 ) return;

			state.activeSpans.splice( index, 1 );
			if ( handle._queries.render.size > 0 || handle._queries.compute.size > 0 ) {

				state.pendingSpans.push( handle );
				this._scheduleGpuFlush( state );

			}

			return;

		}

		if ( state.activeSpan !== handle ) return;

		try {

			state.gl.endQuery( state.extension.TIME_ELAPSED_EXT );
			state.activeSpan = null;
			state.pendingSpans.push( handle );
			this._scheduleGpuFlush( state );

		} catch ( error ) {

			state.activeSpan = null;
			state.gl.deleteQuery( handle._query );
			warnOnce( `ProfilerService: Unable to end a WebGL GPU span (${error.message}).` );

		}

	}

	/**
	 * Resolves pending GPU timestamp queries for a renderer.
	 *
	 * @param {Object} renderer
	 * @return {Promise<void>}
	 */
	async flushGpu( renderer ) {

		const state = this.gpuRendererStates.get( renderer );
		if ( state === undefined || state.available === false ) return;
		if ( state.flushPromise !== null ) return state.flushPromise;

		state.flushPromise = state.kind === 'common'
			? this._flushCommonGpuState( state )
			: this._flushLegacyWebGLState( state );

		try {

			await state.flushPromise;

		} finally {

			state.flushPromise = null;
			if ( state.pendingSpans.length > 0 ) this._scheduleGpuFlush( state );

		}

	}

	/**
	 * @param {Object} renderer
	 * @param {'render'|'compute'} type
	 * @param {string} uid
	 * @param {?string} [label=null]
	 */
	_captureGpuTimestampQuery( renderer, type, uid, label = null ) {

		const state = this.gpuRendererStates.get( renderer );
		if ( state === undefined || state.kind !== 'common' ) return;

		const hasLabel = label !== null && label !== undefined && label !== '';
		if ( state.activeSpans.length === 0 && hasLabel === false ) return;

		const cpuTime = performance.now();
		state.queryCpuTimes.set( uid, cpuTime );

		for ( const span of state.activeSpans ) {

			span._queries[ type ].add( uid );

		}

		// The backend notifies once per query allocation, so a restarted pass reports its uid
		// again; the pending pass span already accumulates that uid's full duration.
		if ( hasLabel && this._hasPendingGpuPass( state, type, uid ) === false ) {

			// Queue labelled passes with the active beginGpu span(s). Flushing
			// immediately would commit them before their parent envelope exists and
			// can anchor gpuTraceOrigin mid-frame, which breaks Speedscope nesting.
			const passSpan = {
				label: `GPU pass: ${label}`,
				renderer,
				t0: cpuTime,
				_seq: ++ this._markId,
				_generation: this._generation,
				_isPass: true,
				_queries: {
					[ TimestampQuery.RENDER ]: new Set(),
					[ TimestampQuery.COMPUTE ]: new Set(),
				},
			};
			passSpan._queries[ type ].add( uid );
			state.pendingSpans.push( passSpan );
			// Only auto-flush when no beginGpu parent is open. Nested parents flush on endGpu
			// so pass slices share one origin and nest inside the parent envelope.
			if ( state.activeSpans.length === 0 ) {

				this._scheduleGpuFlush( state );

			}

		}

	}

	/**
	 * @param {import('./ProfilerService.js').CommonGpuRendererState} state
	 * @param {'render'|'compute'} type
	 * @param {string} uid
	 * @return {boolean}
	 */
	_hasPendingGpuPass( state, type, uid ) {

		for ( const span of state.pendingSpans ) {

			if ( span._isPass === true && span._queries[ type ].has( uid ) ) return true;

		}

		return false;

	}

	/**
	 * @param {import('./ProfilerService.js').GpuRendererState} state
	 */
	_scheduleGpuFlush( state ) {

		if ( state.flushScheduled ) return;
		state.flushScheduled = true;

		const callback = () => {

			state.flushScheduled = false;
			if ( this.gpuRendererStates.get( state.renderer ) === state ) {

				this.flushGpu( state.renderer ).catch( error => {

					warnOnce( `ProfilerService: Unable to resolve GPU timestamps (${error.message}).` );

				} );

			}

		};

		if ( typeof requestAnimationFrame === 'function' ) {

			requestAnimationFrame( callback );

		} else {

			setTimeout( callback, 0 );

		}

	}

	/**
	 * @param {import('./ProfilerService.js').CommonGpuRendererState} state
	 */
	async _flushCommonGpuState( state ) {

		const spans = state.pendingSpans.splice( 0 );
		if ( spans.length === 0 ) return;

		if ( state.renderer.backend.trackTimestamp !== true ) {

			warnOnce( 'ProfilerService: Timestamp tracking was turned off on an attached renderer (e.g. by the Inspector); GPU timings will stop.' );

		}

		const hasRenderQueries = spans.some( span => span._queries.render.size > 0 );
		const hasComputeQueries = spans.some( span => span._queries.compute.size > 0 );
		const resolutions = [];

		if ( hasRenderQueries ) resolutions.push( state.renderer.resolveTimestampsAsync( TimestampQuery.RENDER ) );
		if ( hasComputeQueries ) resolutions.push( state.renderer.resolveTimestampsAsync( TimestampQuery.COMPUTE ) );
		await Promise.all( resolutions );

		if ( this._enabled === false ) return;

		if ( state.gpuTimestampOrigin === null ) {

			const origin = this._findEarliestGpuTimestampOrigin( state, spans );
			if ( origin !== null ) {

				state.gpuTimestampOrigin = origin.gpuTimestampOrigin;
				state.gpuTraceOrigin = origin.gpuTraceOrigin;

			}

		}

		const resolvedUids = new Set();
		/** @type {Array<{ label: string, startTime: number, durationMs: number, traceDurationMs: number, isPass: boolean, uids: string[], traceTs?: number, traceDur?: number }>} */
		const samples = [];
		/** @type {import('./ProfilerService.js').GpuSpanHandle[]} */
		const committedSpans = [];
		/** @type {Set<string>} */
		const labelledQueryUids = new Set();

		for ( const span of spans ) {

			if ( span._generation !== this._generation ) continue;

			let duration = 0;
			let resolvedQueries = 0;
			let rangedQueries = 0;
			let gpuStart = null;
			let gpuEnd = null;
			for ( const type of [ TimestampQuery.RENDER, TimestampQuery.COMPUTE ] ) {

				for ( const uid of span._queries[ type ] ) {

					if ( state.renderer.backend.hasTimestampQuery( uid ) ) {

						duration += state.renderer.backend.getTimestamp( uid );
						resolvedQueries ++;
						resolvedUids.add( uid );

						const range = state.renderer.backend.getTimestampRange( uid );
						if ( range !== null ) {

							rangedQueries ++;
							if ( gpuStart === null || range.start < gpuStart ) gpuStart = range.start;
							if ( gpuEnd === null || range.end > gpuEnd ) gpuEnd = range.end;

						}

					}

				}

			}

			if ( resolvedQueries === 0 ) {

				// The pool can skip a resolve (e.g. its result buffer is still mapped), so
				// retry on the next flushes before giving up on the span.
				span._flushAttempts = ( span._flushAttempts ?? 0 ) + 1;
				if ( span._flushAttempts < GPU_FLUSH_MAX_ATTEMPTS ) {

					state.pendingSpans.push( span );

				} else {

					warnOnce( 'ProfilerService: Dropped GPU spans whose timestamps never resolved; another consumer of resolveTimestampsAsync() (e.g. the Inspector) may be taking them.' );

				}

				continue;

			}

			committedSpans.push( span );

			let startTime = span.t0;
			let traceDurationMs = duration;
			// The trace slice uses the device envelope whenever any query has a range, so
			// pass slices nest inside it. Stats keep the summed pass durations: the envelope
			// also covers idle gaps between passes.
			if ( rangedQueries > 0 && gpuStart !== null && gpuEnd !== null && state.gpuTimestampOrigin !== null ) {

				traceDurationMs = Number( gpuEnd - gpuStart ) / 1e6;
				startTime = state.gpuTraceOrigin + Number( gpuStart - state.gpuTimestampOrigin ) / 1e6;

			}

			const isPass = span.label.startsWith( 'GPU pass:' );
			const uids = [ ...span._queries[ TimestampQuery.RENDER ], ...span._queries[ TimestampQuery.COMPUTE ] ];
			if ( isPass ) {

				for ( const uid of uids ) labelledQueryUids.add( uid );

			}

			samples.push( {
				label: span.label,
				startTime,
				durationMs: duration,
				traceDurationMs,
				isPass,
				uids,
			} );

		}

		// Parent beginGpu spans collect every timestamp query, including renders that
		// had no gpuProfilerLabel. Surface those as pass slices so they are not empty
		// holes under the parent envelope.
		for ( const span of committedSpans ) {

			if ( span.label.startsWith( 'GPU pass:' ) ) continue;
			if ( state.gpuTimestampOrigin === null ) continue;

			for ( const type of [ TimestampQuery.RENDER, TimestampQuery.COMPUTE ] ) {

				for ( const uid of span._queries[ type ] ) {

					if ( labelledQueryUids.has( uid ) ) continue;
					if ( state.renderer.backend.hasTimestampQuery( uid ) === false ) continue;

					const range = state.renderer.backend.getTimestampRange( uid );
					if ( range === null ) continue;

					const durationMs = Number( range.end - range.start ) / 1e6;
					if ( durationMs <= 0 ) continue;

					samples.push( {
						label: 'GPU pass: (unlabeled)',
						startTime: state.gpuTraceOrigin + Number( range.start - state.gpuTimestampOrigin ) / 1e6,
						durationMs,
						traceDurationMs: durationMs,
						isPass: true,
						uids: [ uid ],
					} );
					labelledQueryUids.add( uid );

				}

			}

		}

		for ( const sample of samples ) {

			sample.traceTs = Math.round( this._getTraceTimestamp( sample.startTime ) );
			sample.traceDur = Math.round( this._getTraceTimestamp( sample.startTime + sample.traceDurationMs ) ) - sample.traceTs;

		}

		// Zero-length slices are committed to stats only, so they take no part in trace layout.
		const passSamples = samples.filter( sample => sample.isPass );
		const otherSamples = samples.filter( sample => sample.isPass === false );
		const tracedPasses = passSamples.filter( sample => sample.traceDur > 0 );
		this._snapHalfOpenGpuPassTraceIntervals( tracedPasses );
		this._fitGpuParentTraceToPasses( otherSamples, tracedPasses );

		// Passes before parents, and inner parents before outer ones (their end order), as on
		// the CPU rows: exportChromeTrace() relies on it to list a parent first when it covers
		// the same range as its child.
		for ( const sample of passSamples ) {

			this._commitGpuDurationSample( sample.label, sample.startTime, sample.durationMs, {
				ts: sample.traceTs,
				dur: sample.traceDur,
			} );

		}

		for ( const sample of otherSamples ) {

			this._commitGpuDurationSample( sample.label, sample.startTime, sample.durationMs, {
				ts: sample.traceTs,
				dur: sample.traceDur,
			} );

		}

		// Keep CPU times for queries still referenced by active parent spans.
		for ( const uid of resolvedUids ) {

			if ( this._isGpuQueryReferencedByActiveSpans( state, uid ) ) continue;
			state.queryCpuTimes.delete( uid );

		}

		this._pruneGpuQueryCpuTimes( state );

	}

	/**
	 * Drops CPU times for queries that never resolved (pool overflow, timestamps taken by
	 * another resolver) once they are too old to anchor a trace origin.
	 *
	 * @param {import('./ProfilerService.js').CommonGpuRendererState} state
	 */
	_pruneGpuQueryCpuTimes( state ) {

		const cutoff = performance.now() - GPU_QUERY_CPU_TIME_TTL_MS;

		for ( const [ uid, cpuTime ] of state.queryCpuTimes ) {

			if ( cpuTime >= cutoff ) continue;
			if ( this._isGpuQueryReferencedByActiveSpans( state, uid ) ) continue;
			state.queryCpuTimes.delete( uid );

		}

	}

	/**
	 * Convert labelled GPU pass samples to non-overlapping half-open µs intervals for
	 * Chrome/Speedscope traces. Stats keep the raw measured durations.
	 *
	 * @param {Array<{ traceTs: number, traceDur: number }>} samples
	 */
	_snapHalfOpenGpuPassTraceIntervals( samples ) {

		if ( samples.length === 0 ) return;

		// Longer first at the same timestamp so the substantial pass keeps its start.
		samples.sort( ( a, b ) => a.traceTs - b.traceTs || b.traceDur - a.traceDur );

		let cursor = Number.NEGATIVE_INFINITY;
		for ( const sample of samples ) {

			if ( sample.traceTs < cursor ) {

				const end = Math.max( sample.traceTs + sample.traceDur, cursor + 1 );
				sample.traceTs = cursor;
				sample.traceDur = Math.max( 1, end - sample.traceTs );

			}

			cursor = sample.traceTs + sample.traceDur;

		}

	}

	/**
	 * Trace viewers nest by time containment on a thread. Snapping moves passes, so a
	 * parent's raw envelope can stick out of its passes or miss part of them. Fit each
	 * parent to exactly the snapped passes of its own queries: sibling parents then cover
	 * disjoint pass runs and never partially overlap, and every pass stays inside its parent.
	 *
	 * @param {Array<{ uids: string[], traceTs: number, traceDur: number }>} parents
	 * @param {Array<{ uids: string[], traceTs: number, traceDur: number }>} passes
	 */
	_fitGpuParentTraceToPasses( parents, passes ) {

		if ( parents.length === 0 || passes.length === 0 ) return;

		/** @type {Map<string, { traceTs: number, traceDur: number }>} */
		const passByUid = new Map();
		for ( const pass of passes ) {

			for ( const uid of pass.uids ) passByUid.set( uid, pass );

		}

		for ( const parent of parents ) {

			let minTs = Infinity;
			let maxEnd = - Infinity;

			for ( const uid of parent.uids ) {

				const pass = passByUid.get( uid );
				if ( pass === undefined ) continue;
				if ( pass.traceTs < minTs ) minTs = pass.traceTs;
				if ( pass.traceTs + pass.traceDur > maxEnd ) maxEnd = pass.traceTs + pass.traceDur;

			}

			if ( minTs === Infinity ) continue;

			parent.traceTs = minTs;
			parent.traceDur = maxEnd - minTs;

		}

	}

	/**
	 * @param {import('./ProfilerService.js').CommonGpuRendererState} state
	 * @param {import('./ProfilerService.js').GpuSpanHandle[]} spans
	 * @return {?{ gpuTimestampOrigin: bigint, gpuTraceOrigin: number }}
	 */
	_findEarliestGpuTimestampOrigin( state, spans ) {

		let earliestRange = null;
		let earliestUid = null;
		const candidates = spans.concat( state.activeSpans );

		for ( const span of candidates ) {

			for ( const type of [ TimestampQuery.RENDER, TimestampQuery.COMPUTE ] ) {

				const queries = span._queries?.[ type ];
				if ( queries === undefined ) continue;

				for ( const uid of queries ) {

					const range = state.renderer.backend.getTimestampRange( uid );
					if ( range !== null && ( earliestRange === null || range.start < earliestRange.start ) ) {

						earliestRange = range;
						earliestUid = uid;

					}

				}

			}

		}

		if ( earliestRange === null ) return null;

		return {
			gpuTimestampOrigin: earliestRange.start,
			gpuTraceOrigin: state.queryCpuTimes.get( earliestUid ) ?? spans[ 0 ].t0,
		};

	}

	/**
	 * @param {import('./ProfilerService.js').CommonGpuRendererState} state
	 * @param {string} uid
	 * @return {boolean}
	 */
	_isGpuQueryReferencedByActiveSpans( state, uid ) {

		for ( const span of state.activeSpans ) {

			if ( span._queries.render.has( uid ) || span._queries.compute.has( uid ) ) return true;

		}

		return false;

	}

	/**
	 * @param {import('./ProfilerService.js').LegacyWebGLGpuRendererState} state
	 */
	async _flushLegacyWebGLState( state ) {

		const spans = state.pendingSpans.splice( 0 );

		for ( const span of spans ) {

			if ( span._generation !== this._generation ) {

				state.gl.deleteQuery( span._query );
				continue;

			}

			const duration = await this._resolveLegacyWebGLQuery( state, span._query );
			if ( duration !== null && span._generation === this._generation && this._enabled ) {

				this._commitGpuDurationSample( span.label, span.t0, duration );

			}

		}

	}

	/**
	 * Polls once per animation frame. Never rejects: errors and disjoint events resolve `null`.
	 *
	 * @param {import('./ProfilerService.js').LegacyWebGLGpuRendererState} state
	 * @param {WebGLQuery} query
	 * @return {Promise<?number>}
	 */
	_resolveLegacyWebGLQuery( state, query ) {

		return new Promise( resolve => {

			const gl = state.gl;
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

					if ( gl.getParameter( state.extension.GPU_DISJOINT_EXT ) ) disjoint = true;

					if ( gl.getQueryParameter( query, gl.QUERY_RESULT_AVAILABLE ) === false ) {

						if ( typeof requestAnimationFrame === 'function' ) requestAnimationFrame( poll );
						else setTimeout( poll, 4 );
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

	/**
	 * @param {string} label Stats key; keep it stable so samples aggregate.
	 * @param {string} [traceName] Trace slice and User Timing name, defaulting to `label`.
	 * Can carry per-call context such as object names; build it only when {@link ProfilerServiceClass#isTracing}.
	 */
	_beginImpl( label, traceName ) {

		const startTime = performance.now();
		const record = this._getLabelRecord( label );
		record.starts.push( startTime );
		record.traceNames.push( traceName );
		this.callStack.push( { label, seq: 0, t0: startTime, childTime: 0 } );

	}

	/**
	 * @param {string} label
	 */
	_endImpl( label ) {

		const record = this.labels.get( label );
		if ( record === undefined || record.starts.length === 0 ) return;

		const startTime = record.starts.pop();
		const traceName = record.traceNames.pop() ?? label;
		const now = performance.now();
		if ( this._profile === 'full' ) this._measure( `gnsx:${traceName}`, startTime, now );

		this._commitFrameSample( record, startTime, now - startTime, this._findScopeFrame( label ), traceName );

	}

	/**
	 * @param {string} label
	 * @return {import('./ProfilerService.js').CpuLabelRecord}
	 */
	_getLabelRecord( label ) {

		let record = this.labels.get( label );
		if ( record === undefined ) {

			record = {
				label,
				buffer: new Float64Array( RING_SIZE ),
				selfBuffer: new Float64Array( RING_SIZE ).fill( NaN ),
				cursor: 0,
				count: 0,
				invocations: 0,
				starts: [],
				traceNames: [],
			};
			this.labels.set( label, record );

		}

		return record;

	}

	/**
	 * Per-invocation span start (pair with {@link ProfilerServiceClass#endSpan}).
	 * Safe for concurrent async with the same label.
	 *
	 * @param {string} label
	 * @param {import('./ProfilerService.js').BeginSpanOptions} [opts]
	 * @return {import('./ProfilerService.js').SpanHandle}
	 */
	_beginSpanImpl( label, opts ) {

		const seq = ++ this._markId;
		const t0 = performance.now();
		if ( opts?.asyncTimeline !== true ) this.callStack.push( { label, seq, t0, childTime: 0 } );
		return { label, t0, _seq: seq, _generation: this._generation };

	}

	/**
	 * @param {import('./ProfilerService.js').SpanHandle} handle
	 * @param {import('./ProfilerService.js').EndSpanOptions} [opts]
	 */
	_endSpanImpl( handle, opts ) {

		if ( handle._seq === 0 || handle._generation !== this._generation ) return;

		const now = performance.now();
		const duration = now - handle.t0;
		if ( this._profile === 'full' ) this._measure( `gnsx:${handle.label}#${handle._seq}`, handle.t0, now );

		const record = this._getLabelRecord( handle.label );

		if ( opts?.asyncTimeline === true ) {

			// Async completions land at arbitrary times: drop the span's frame without
			// touching the scopes that are open right now.
			this._detachSpanFrame( handle );
			this._commitDurationSample( record, handle.t0, duration, NaN, true, `${handle.label} (promise)`, TRACE_TID_ASYNC );
			return;

		}

		this._commitFrameSample( record, handle.t0, duration, this._findSpanFrame( handle._seq ), handle.label );

	}

	/**
	 * Commits a synchronous scope or span and closes its call-stack frame. Work that does not
	 * nest inside the frames around it cannot go on the main row, so it is recorded on the
	 * async row instead.
	 *
	 * @param {import('./ProfilerService.js').CpuLabelRecord} record
	 * @param {number} startTime
	 * @param {number} durationMs
	 * @param {number} frameIndex
	 * @param {string} traceName
	 */
	_commitFrameSample( record, startTime, durationMs, frameIndex, traceName ) {

		const label = record.label;

		// An enclosing scope or span ended first and discarded this frame.
		if ( frameIndex === - 1 ) {

			this._warnOutOfOrder( label );
			this._commitDurationSample( record, startTime, durationMs, NaN, true, `${traceName} (out of order)`, TRACE_TID_ASYNC );
			return;

		}

		// A call nested in an open call with the same label is already inside that call's
		// inclusive time, so only its self time is recorded.
		const inclusive = this._hasEnclosingFrame( label, frameIndex ) === false;

		if ( this._hasOpenSpanAbove( frameIndex ) ) {

			this._warnOutOfOrder( label );
			const selfTime = this._closeOverlappedFrame( frameIndex );
			this._commitDurationSample( record, startTime, durationMs, selfTime, inclusive, `${traceName} (out of order)`, TRACE_TID_ASYNC );
			return;

		}

		const selfTime = this._closeFrame( frameIndex, durationMs );
		this._commitDurationSample( record, startTime, durationMs, selfTime, inclusive, traceName, TRACE_TID_MAIN );

	}

	/**
	 * Closes call-stack frame `frameIndex` and credits its duration to the parent. Frames above
	 * it belong to scopes that never ended (early return, exception) and are discarded.
	 *
	 * @param {number} frameIndex
	 * @param {number} durationMs
	 * @return {number} Self time.
	 */
	_closeFrame( frameIndex, durationMs ) {

		const frame = this.callStack[ frameIndex ];
		this.callStack.length = frameIndex;
		if ( frameIndex > 0 ) this.callStack[ frameIndex - 1 ].childTime += durationMs;
		return Math.max( 0, durationMs - frame.childTime );

	}

	/**
	 * Closes call-stack frame `frameIndex` while frames that started inside it stay open. Those
	 * frames now nest in the parent, which is credited only with the time before they started,
	 * so the overlap is not counted twice.
	 *
	 * @param {number} frameIndex
	 * @return {number} Self time.
	 */
	_closeOverlappedFrame( frameIndex ) {

		const frame = this.callStack[ frameIndex ];
		const exclusiveMs = Math.max( 0, this.callStack[ frameIndex + 1 ].t0 - frame.t0 );
		this.callStack.splice( frameIndex, 1 );
		if ( frameIndex > 0 ) this.callStack[ frameIndex - 1 ].childTime += exclusiveMs;
		return Math.max( 0, exclusiveMs - frame.childTime );

	}

	/**
	 * @param {string} label
	 * @param {number} frameIndex
	 * @return {boolean} Whether a frame below `frameIndex` has the same label.
	 */
	_hasEnclosingFrame( label, frameIndex ) {

		for ( let i = 0; i < frameIndex; i ++ ) {

			if ( this.callStack[ i ].label === label ) return true;

		}

		return false;

	}

	/**
	 * Spans always end (`@profile` closes them in `finally`), so a span frame above
	 * `frameIndex` is still open rather than abandoned like an unbalanced scope.
	 *
	 * @param {number} frameIndex
	 * @return {boolean}
	 */
	_hasOpenSpanAbove( frameIndex ) {

		for ( let i = frameIndex + 1; i < this.callStack.length; i ++ ) {

			if ( this.callStack[ i ].seq !== 0 ) return true;

		}

		return false;

	}

	/**
	 * @param {string} label
	 */
	_warnOutOfOrder( label ) {

		warnOnce( `ProfilerService: "${label}" did not nest inside the scopes and spans around it and is recorded on the async row. Pass { asyncTimeline: true } to beginSpan() and endSpan() for work that outlives its caller.` );

	}

	/**
	 * Removes a span's call-stack frame once its synchronous part has finished, so later
	 * sibling scopes are attributed to the real parent. No-op for dummy and stale handles.
	 *
	 * @param {import('./ProfilerService.js').SpanHandle} handle
	 */
	_detachSpanFrame( handle ) {

		if ( handle._seq === 0 || handle._generation !== this._generation ) return;

		const index = this._findSpanFrame( handle._seq );
		if ( index !== - 1 ) this.callStack.splice( index, 1 );

	}

	/**
	 * @param {string} label
	 * @return {number} Index of the innermost open scope frame for `label`, or -1.
	 */
	_findScopeFrame( label ) {

		for ( let i = this.callStack.length - 1; i >= 0; i -- ) {

			const frame = this.callStack[ i ];
			if ( frame.seq === 0 && frame.label === label ) return i;

		}

		return - 1;

	}

	/**
	 * @param {number} seq
	 * @return {number} Index of the span frame with `seq`, or -1.
	 */
	_findSpanFrame( seq ) {

		for ( let i = this.callStack.length - 1; i >= 0; i -- ) {

			if ( this.callStack[ i ].seq === seq ) return i;

		}

		return - 1;

	}

	/**
	 * @param {string} name
	 * @param {number} start
	 * @param {number} end
	 */
	_measure( name, start, end ) {

		if ( this._userTimingEntries >= this.maxTraceEvents ) return;

		try {

			performance.measure( name, { start, end } );
			this._userTimingEntries ++;

		} catch {

			// User Timing is optional DevTools integration; never let it break profiling.

		}

	}

	_clearUserTiming() {

		this._userTimingEntries = 0;
		if ( typeof performance.getEntriesByType !== 'function' ) return;

		for ( const type of [ 'measure', 'mark' ] ) {

			const names = new Set();
			for ( const entry of performance.getEntriesByType( type ) ) {

				if ( entry.name.startsWith( 'gnsx:' ) ) names.add( entry.name );

			}

			for ( const name of names ) {

				if ( type === 'measure' ) performance.clearMeasures( name );
				else performance.clearMarks( name );

			}

		}

	}

	/**
	 * @param {ChromeTraceEvent} event
	 */
	_pushTraceEvent( event ) {

		if ( this.traceEvents.length >= this.maxTraceEvents ) {

			warnOnce( `ProfilerService: Trace limit reached (${this.maxTraceEvents} events); later events are dropped. Call reset() or downloadTrace() sooner.` );
			return;

		}

		this.traceEvents.push( event );

	}

	/**
	 * @param {import('./ProfilerService.js').CpuLabelRecord} record
	 * @param {number} startTime
	 * @param {number} durationMs
	 * @param {number} selfTime Exclusive time, or `NaN` when the sample has none.
	 * @param {boolean} inclusive Whether `durationMs` counts towards inclusive stats.
	 * @param {string} traceName
	 * @param {typeof TRACE_TID_MAIN|typeof TRACE_TID_ASYNC} traceTid
	 */
	_commitDurationSample( record, startTime, durationMs, selfTime, inclusive, traceName, traceTid ) {

		// Inclusive and self samples share one cursor so both stats cover the same calls.
		// NaN marks a sample without that kind of time.
		const cursor = record.cursor;
		record.buffer[ cursor ] = inclusive ? durationMs : NaN;
		record.selfBuffer[ cursor ] = selfTime;
		record.cursor = ( cursor + 1 ) % RING_SIZE;
		if ( record.count < RING_SIZE ) record.count ++;
		record.invocations ++;

		if ( this._profile === 'full' ) {

			// Rounding both endpoints keeps rounded children inside their rounded parent.
			const ts = Math.round( this._getTraceTimestamp( startTime ) );
			const dur = Math.round( this._getTraceTimestamp( startTime + durationMs ) ) - ts;
			// Sub-µs slices are left out: padding them to 1 µs can push them past their parent.
			if ( dur > 0 ) {

				this._pushTraceEvent( {
					name: traceName,
					ph: 'X',
					ts,
					dur,
					pid: 1,
					tid: traceTid,
					cat: 'gnsx',
				} );

			}

		}

	}

	/**
	 * @param {string} label
	 * @param {number} startTime
	 * @param {number} durationMs
	 * @param {{ ts: number, dur: number }} [traceOverride]
	 */
	_commitGpuDurationSample( label, startTime, durationMs, traceOverride = null ) {

		let record = this.gpuLabels.get( label );
		if ( record === undefined ) {

			record = { buffer: new Float64Array( RING_SIZE ), cursor: 0, count: 0, invocations: 0 };
			this.gpuLabels.set( label, record );

		}

		record.buffer[ record.cursor ] = durationMs;
		record.cursor = ( record.cursor + 1 ) % RING_SIZE;
		if ( record.count < RING_SIZE ) record.count ++;
		record.invocations ++;

		if ( this._profile === 'full' ) {

			let ts = traceOverride?.ts;
			let dur = traceOverride?.dur;
			if ( traceOverride === null ) {

				ts = Math.round( this._getTraceTimestamp( startTime ) );
				dur = Math.round( this._getTraceTimestamp( startTime + durationMs ) ) - ts;

			}

			if ( dur > 0 ) {

				this._pushTraceEvent( {
					name: label,
					ph: 'X',
					ts,
					dur,
					pid: 1,
					tid: TRACE_TID_GPU,
					cat: 'gnsx-gpu',
				} );

			}

		}

	}

	/**
	 * @param {string} label
	 * @return {number[]}
	 */
	getValidSamples( label ) {

		const record = this.labels.get( label );
		if ( record === undefined || record.count === 0 ) return [];
		return Array.from( record.buffer.subarray( 0, record.count ) ).filter( value => Number.isNaN( value ) === false );

	}

	/**
	 * @param {string} label
	 * @return {number[]}
	 */
	getValidGpuSamples( label ) {

		const record = this.gpuLabels.get( label );
		if ( record === undefined || record.count === 0 ) return [];
		return Array.from( record.buffer.subarray( 0, record.count ) );

	}

	/**
	 * @param {string} label
	 * @return {import('./ProfilerService.js').ProfilerStats|null}
	 */
	getStats( label ) {

		const samples = this.getValidSamples( label );
		if ( samples.length === 0 ) return null;

		const sorted = samples.sort( ( a, b ) => a - b );
		const avg = sorted.reduce( ( a, b ) => a + b, 0 ) / sorted.length;

		// Exclusive (self) time stats over the same window, skipping samples without self time.
		const record = this.labels.get( label );
		const selfSamples = Array.from( record.selfBuffer.subarray( 0, record.count ) )
			.filter( value => Number.isNaN( value ) === false )
			.sort( ( a, b ) => a - b );
		let selfAvg, selfMin, selfMax, selfP95, selfFrameBudget;
		if ( selfSamples.length > 0 ) {

			selfAvg = selfSamples.reduce( ( a, b ) => a + b, 0 ) / selfSamples.length;
			selfMin = selfSamples[ 0 ];
			selfMax = selfSamples[ selfSamples.length - 1 ];
			selfP95 = percentile95( selfSamples );
			selfFrameBudget = ( selfAvg / this.frameBudgetMs ) * 100;

		}

		return {
			label,
			samples: samples.length,
			avg,
			min: sorted[ 0 ],
			max: sorted[ sorted.length - 1 ],
			p95: percentile95( sorted ),
			frameBudget: ( avg / this.frameBudgetMs ) * 100,
			totalInvocations: record.invocations,
			selfAvg,
			selfMin,
			selfMax,
			selfP95,
			selfFrameBudget,
		};

	}

	/**
	 * @param {string} label
	 * @return {import('./ProfilerService.js').GpuProfilerStats|null}
	 */
	getGpuStats( label ) {

		const samples = this.getValidGpuSamples( label );
		if ( samples.length === 0 ) return null;

		const sorted = samples.sort( ( a, b ) => a - b );
		const avg = sorted.reduce( ( a, b ) => a + b, 0 ) / sorted.length;

		return {
			label,
			samples: samples.length,
			avg,
			min: sorted[ 0 ],
			max: sorted[ sorted.length - 1 ],
			p95: percentile95( sorted ),
			frameBudget: ( avg / this.frameBudgetMs ) * 100,
			totalInvocations: this.gpuLabels.get( label ).invocations,
		};

	}

	/**
	 * @return {import('./ProfilerService.js').ProfilerStats[]}
	 */
	getAllStats() {

		return [ ...this.labels.keys() ]
			.map( label => this.getStats( label ) )
			.filter( s => s !== null );

	}

	/**
	 * @return {import('./ProfilerService.js').GpuProfilerStats[]}
	 */
	getAllGpuStats() {

		return [ ...this.gpuLabels.keys() ]
			.map( label => this.getGpuStats( label ) )
			.filter( stats => stats !== null );

	}

	report() {

		const stats = this.getAllStats();
		const gpuStats = this.getAllGpuStats();
		if ( stats.length === 0 && gpuStats.length === 0 ) {

			console.log( '[ProfilerService] No data. Enable profiling first and wait a few frames.' );
			return;

		}

		stats.sort( ( a, b ) => b.avg - a.avg );
		console.table(
			stats.map( s => ( {
				label: s.label,
				'avg ms': s.avg.toFixed( 3 ),
				'self avg ms': s.selfAvg === undefined ? '' : s.selfAvg.toFixed( 3 ),
				'min ms': s.min.toFixed( 3 ),
				'max ms': s.max.toFixed( 3 ),
				'p95 ms': s.p95.toFixed( 3 ),
				'budget %': s.frameBudget.toFixed( 1 ) + '%',
				samples: s.samples,
				calls: s.totalInvocations,
			} ) )
		);

		if ( gpuStats.length > 0 ) {

			gpuStats.sort( ( a, b ) => b.avg - a.avg );
			console.log( '[ProfilerService] GPU timings' );
			console.table(
				gpuStats.map( stats => ( {
					label: stats.label,
					'avg ms': stats.avg.toFixed( 3 ),
					'min ms': stats.min.toFixed( 3 ),
					'max ms': stats.max.toFixed( 3 ),
					'p95 ms': stats.p95.toFixed( 3 ),
					'budget %': stats.frameBudget.toFixed( 1 ) + '%',
					samples: stats.samples,
					calls: stats.totalInvocations,
				} ) )
			);

		}

	}

	/**
	 * @param {number} [minDurationMs=0] Omit complete spans shorter than this duration (ms). Capture is unaffected.
	 * @return {import('./ProfilerService.js').ChromeTrace}
	 */
	exportChromeTrace( minDurationMs = 0 ) {

		const thresholdMs = Number.isFinite( minDurationMs ) && minDurationMs > 0 ? minDurationMs : 0;
		const minDurUs = thresholdMs * 1000;
		const slices = minDurUs > 0
			? this.traceEvents.filter( e => ( e.dur ?? 0 ) >= minDurUs )
			: [ ...this.traceEvents ];
		// Parents before children: at equal start the longer slice comes first. Slices are
		// recorded when they end, so a child is recorded before a parent with the same range;
		// reversing first makes the stable sort list that parent first, and viewers nest
		// equal slices in file order.
		slices.reverse();
		slices.sort( ( a, b ) => a.ts - b.ts || a.tid - b.tid || b.dur - a.dur );
		const asyncRowCount = this._assignAsyncTraceRows( slices );
		const hasGpu = slices.some( e => e.tid === TRACE_TID_GPU );
		/** @type {import('./ProfilerService.js').ChromeTraceMetadataEvent[]} */
		const prefix = [
			{
				cat: '__metadata',
				name: 'process_name',
				ph: 'M',
				pid: 1,
				tid: 0,
				ts: 0,
				args: { name: 'Genesys Profiler' },
			},
			{
				cat: '__metadata',
				name: 'thread_name',
				ph: 'M',
				pid: 1,
				tid: TRACE_TID_MAIN,
				ts: 0,
				args: { name: 'Main thread' },
			},
		];
		for ( let row = 0; row < asyncRowCount; row ++ ) {

			prefix.push( {
				cat: '__metadata',
				name: 'thread_name',
				ph: 'M',
				pid: 1,
				tid: row === 0 ? TRACE_TID_ASYNC : TRACE_TID_ASYNC_OVERFLOW + row,
				ts: 0,
				args: { name: row === 0 ? 'Async (promise lifetime)' : `Async (promise lifetime) ${row + 1}` },
			} );

		}

		if ( hasGpu ) {

			prefix.push( {
				cat: '__metadata',
				name: 'thread_name',
				ph: 'M',
				pid: 1,
				tid: TRACE_TID_GPU,
				ts: 0,
				args: { name: 'GPU (device timestamps)' },
			} );

		}

		return {
			displayTimeUnit: 'ms',
			traceEvents: [ ...prefix, ...slices ],
		};

	}

	/**
	 * Promise lifetimes overlap freely, but complete events on one thread must nest. Moves
	 * each async slice onto the first row where it nests or follows, copying moved events so
	 * captured data is untouched. Expects `slices` sorted by start, longer first.
	 *
	 * @param {ChromeTraceEvent[]} slices
	 * @return {number} Number of async rows used.
	 */
	_assignAsyncTraceRows( slices ) {

		/** @type {number[][]} Open slice end times per row (innermost last). */
		const rows = [];

		for ( let i = 0; i < slices.length; i ++ ) {

			const event = slices[ i ];
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
			if ( row > 0 ) slices[ i ] = { ...event, tid: TRACE_TID_ASYNC_OVERFLOW + row };

		}

		return rows.length;

	}

	/**
	 * @param {number} time
	 * @return {number}
	 */
	_getTraceTimestamp( time ) {

		return ( time - this.traceStartTime ) * 1000;

	}

	/**
	 * @param {string} [filename='gnsx-trace.json']
	 * @param {number} [minDurationMs=0] Omit complete spans shorter than this duration (ms).
	 */
	downloadTrace( filename = 'gnsx-trace.json', minDurationMs = 0 ) {

		if ( typeof document === 'undefined' ) {

			console.log( '[ProfilerService] downloadTrace() only works in the browser. Use exportChromeTrace() in Node.js.' );
			return;

		}

		if ( this._profile !== 'full' ) {

			console.log( `[ProfilerService] No trace — current profile is '${this._profile}'. Use setProfile('full') before enabling.` );
			return;

		}

		if ( this.traceEvents.length === 0 ) {

			console.log( '[ProfilerService] No trace events. Enable the profiler and play for a few seconds first.' );
			return;

		}

		const thresholdMs = Number.isFinite( minDurationMs ) && minDurationMs > 0 ? minDurationMs : 0;
		const trace = this.exportChromeTrace( thresholdMs );
		const eventCount = trace.traceEvents.filter( e => e.ph === 'X' ).length;
		// One string per event: a single JSON.stringify of a long session can exceed the
		// engine's maximum string length.
		const parts = [ `{"displayTimeUnit":${JSON.stringify( trace.displayTimeUnit )},"traceEvents":[` ];
		for ( let i = 0; i < trace.traceEvents.length; i ++ ) {

			parts.push( i === 0 ? JSON.stringify( trace.traceEvents[ i ] ) : ',' + JSON.stringify( trace.traceEvents[ i ] ) );

		}

		parts.push( ']}' );
		const blob = new Blob( parts, { type: 'application/json' } );
		const url = URL.createObjectURL( blob );
		const a = document.createElement( 'a' );
		a.href = url;
		a.download = filename;
		a.click();
		// Revoking synchronously can cancel the download in some browsers.
		setTimeout( () => URL.revokeObjectURL( url ), 1000 );
		const thresholdNote = thresholdMs > 0
			? ` (filtered ${this.traceEvents.length - eventCount} spans < ${thresholdMs} ms)`
			: '';
		console.log( `[ProfilerService] Trace downloaded: ${filename} (${eventCount} events${thresholdNote})` );

	}

	/**
	 * @return {import('./ProfilerService.js').ProfilerStats[]}
	 */
	exportJSON() {

		return this.getAllStats();

	}

	/**
	 * @return {import('./ProfilerService.js').GpuProfilerStats[]}
	 */
	exportGpuJSON() {

		return this.getAllGpuStats();

	}

	_clearState() {

		this._generation ++;
		for ( const state of this.gpuRendererStates.values() ) {

			this._clearGpuRendererState( state );

		}

		this.labels.clear();
		this.traceEvents = [];
		this.traceStartTime = performance.now();
		this._markId = 0;
		this._clearUserTiming();
		this.callStack.length = 0;
		this.gpuLabels.clear();

	}

	/**
	 * @param {import('./ProfilerService.js').GpuRendererState} state
	 */
	_clearGpuRendererState( state ) {

		if ( state.kind === 'common' ) {

			state.activeSpans.length = 0;
			state.pendingSpans.length = 0;
			state.queryCpuTimes.clear();
			state.gpuTimestampOrigin = null;
			state.gpuTraceOrigin = null;
			return;

		}

		if ( state.activeSpan !== null ) {

			try {

				state.gl.endQuery( state.extension.TIME_ELAPSED_EXT );

			} catch {

				// The context may have been lost while the query was active.

			}

			state.gl.deleteQuery( state.activeSpan._query );
			state.activeSpan = null;

		}

		// An in-flight flush has already taken its own spans out of pendingSpans and deletes
		// their queries itself; everything still queued here belongs to nobody else.
		for ( const span of state.pendingSpans ) {

			state.gl.deleteQuery( span._query );

		}

		state.pendingSpans.length = 0;

	}

	_detachGpuRenderers() {

		for ( const state of this.gpuRendererStates.values() ) {

			if ( state.kind === 'common' && state.available ) {

				state.renderer.backend.removeTimestampQueryListener( state.listener );
				state.renderer.backend.trackTimestamp = state.previousTrackTimestamp;

			}

		}

		this.gpuRendererStates.clear();

	}

	reset() {

		this._clearState();
		console.log( '[ProfilerService] data reset' );

	}

}

/**
 * @typedef {Object} ProfilerStats
 * @property {string} label
 * @property {number} samples Inclusive samples; recursive calls only contribute their outermost call.
 * @property {number} avg
 * @property {number} min
 * @property {number} max
 * @property {number} p95 Nearest-rank 95th percentile.
 * @property {number} frameBudget Average as a percentage of `frameBudgetMs` (one 60 fps frame by default).
 * @property {number} totalInvocations Total (uncapped) call count since last reset, recursive calls included.
 * @property {number|undefined} selfAvg Exclusive (self) avg ms — inclusive time minus child scope time.
 * @property {number|undefined} selfMin
 * @property {number|undefined} selfMax
 * @property {number|undefined} selfP95
 * @property {number|undefined} selfFrameBudget Exclusive average as a percentage of `frameBudgetMs`.
 */

/**
 * @typedef {Object} GpuProfilerStats
 * @property {string} label
 * @property {number} samples
 * @property {number} avg
 * @property {number} min
 * @property {number} max
 * @property {number} p95 Nearest-rank 95th percentile.
 * @property {number} frameBudget Average as a percentage of `frameBudgetMs` (one 60 fps frame by default).
 * @property {number} totalInvocations
 */

/**
 * @typedef {Object} CpuLabelRecord
 * @property {string} label
 * @property {Float64Array} buffer Inclusive time ring buffer; `NaN` for calls nested in a call with the same label.
 * @property {Float64Array} selfBuffer Exclusive time at the same ring index; `NaN` for async and out-of-order work.
 * @property {number} cursor
 * @property {number} count Valid samples in the ring buffers.
 * @property {number} invocations Total (uncapped) samples since last reset.
 * @property {number[]} starts Open `begin()` start times.
 * @property {Array<string|undefined>} traceNames Trace names passed to the open `begin()` calls, parallel to `starts`.
 */

/**
 * @typedef {Object} GpuLabelRecord
 * @property {Float64Array} buffer
 * @property {number} cursor
 * @property {number} count
 * @property {number} invocations
 */

/**
 * @typedef {Object} SpanHandle
 * @property {string} label
 * @property {number} t0
 * @property {number} _seq
 * @property {number} _generation Session the span started in.
 */

/**
 * @typedef {Object} BeginSpanOptions
 * @property {boolean} [asyncTimeline] When true, the span is ended from an async continuation
 * and does not take part in self-time nesting.
 */

/**
 * @typedef {Object} GpuSpanHandle
 * @property {string} label
 * @property {?Object} renderer
 * @property {number} t0
 * @property {number} _seq
 * @property {number} _generation
 * @property {{render: Set<string>, compute: Set<string>}} [_queries]
 * @property {WebGLQuery} [_query]
 * @property {boolean} [_isPass] Created for a labelled pass reported by the backend.
 * @property {number} [_flushAttempts] Flushes that found none of the span's timestamps resolved.
 */

/**
 * @typedef {Object} CommonGpuRendererState
 * @property {'common'} kind
 * @property {boolean} available
 * @property {Object} renderer
 * @property {function('render'|'compute', string, ?string): void} listener
 * @property {boolean} previousTrackTimestamp
 * @property {GpuSpanHandle[]} activeSpans
 * @property {GpuSpanHandle[]} pendingSpans
 * @property {Map<string, number>} queryCpuTimes
 * @property {?bigint} gpuTimestampOrigin
 * @property {?number} gpuTraceOrigin
 * @property {?Promise<void>} flushPromise
 * @property {boolean} flushScheduled
 */

/**
 * @typedef {Object} LegacyWebGLGpuRendererState
 * @property {'legacy-webgl'} kind
 * @property {boolean} available
 * @property {Object} renderer
 * @property {WebGL2RenderingContext} gl
 * @property {?EXT_disjoint_timer_query_webgl2} extension
 * @property {?GpuSpanHandle} activeSpan
 * @property {GpuSpanHandle[]} pendingSpans
 * @property {?Promise<void>} flushPromise
 * @property {boolean} flushScheduled
 */

/**
 * @typedef {CommonGpuRendererState|LegacyWebGLGpuRendererState} GpuRendererState
 */

/**
 * @typedef {Object} EndSpanOptions
 * @property {boolean} [asyncTimeline] When true, trace slice uses `tid=2` (virtual async row).
 */

/**
 * @typedef {Object} ChromeTraceEvent
 * @property {string} name
 * @property {'X'} ph
 * @property {number} ts
 * @property {number} dur
 * @property {1} pid
 * @property {number} tid
 * @property {'gnsx'|'gnsx-gpu'} cat
 */

/**
 * @typedef {Object} ChromeTraceMetadataEvent
 * @property {'__metadata'} cat
 * @property {'process_name'|'thread_name'} name
 * @property {'M'} ph
 * @property {1} pid
 * @property {number} [tid]
 * @property {0} ts
 * @property {{ name: string }} args
 */

/**
 * @typedef {Object} ChromeTrace
 * @property {'ms'} displayTimeUnit
 * @property {Array<ChromeTraceEvent|ChromeTraceMetadataEvent>} traceEvents
 */

/**
 * @typedef {'full'|'stats'} ProfilingProfile
 */

const ProfilerService = new ProfilerServiceClass();

/**
 * Nearest-rank 95th percentile.
 *
 * @param {number[]} sorted Ascending, non-empty.
 * @return {number}
 */
function percentile95( sorted ) {

	return sorted[ Math.max( 0, Math.ceil( sorted.length * 0.95 ) - 1 ) ];

}

function isThenable( x ) {

	return (
		( typeof x === 'object' || typeof x === 'function' ) &&
		x !== null &&
		typeof x.then === 'function'
	);

}

/** @type {WeakSet<Function>} Wrappers created by the decorators, so methods are never wrapped twice. */
const profiledMethods = new WeakSet();

function applyProfileToMethod( label, descriptor ) {

	const original = descriptor.value;
	if ( profiledMethods.has( original ) ) return descriptor;

	function profiled() {

		// Disabled: no allocations, and promises come back unwrapped.
		if ( ProfilerService._enabled === false ) return original.apply( this, arguments );

		const span = ProfilerService.beginSpan( label );
		try {

			const result = original.apply( this, arguments );
			if ( isThenable( result ) ) {

				ProfilerService._detachSpanFrame( span );
				return Promise.resolve( result ).finally( () => ProfilerService.endSpan( span, { asyncTimeline: true } ) );

			}

			ProfilerService.endSpan( span );
			return result;

		} catch ( error ) {

			ProfilerService.endSpan( span );
			throw error;

		}

	}

	Object.defineProperty( profiled, 'name', { value: original.name, configurable: true } );
	profiledMethods.add( profiled );
	descriptor.value = profiled;
	return descriptor;

}

/**
 * Method decorator that profiles the decorated method.
 * Default label: `ClassName.methodName`. Pass a custom tag via `@profile('My tag')`.
 *
 * @param {Object|string} [targetOrTag]
 * @param {string|symbol} [propertyKey]
 * @param {PropertyDescriptor} [descriptor]
 * @return {PropertyDescriptor|function(Object, string|symbol, PropertyDescriptor): PropertyDescriptor}
 */
function profile( targetOrTag, propertyKey, descriptor ) {

	if ( arguments.length === 0 ) {

		return defaultProfileDecorator;

	}

	if ( arguments.length === 1 && typeof targetOrTag === 'string' ) {

		const customTag = targetOrTag;
		return ( target, key, desc ) => applyProfileToMethod( customTag, desc );

	}

	return defaultProfileDecorator( targetOrTag, propertyKey, descriptor );

}

/**
 * @param {Object} target
 * @param {string|symbol} propertyKey
 * @param {PropertyDescriptor} descriptor
 * @return {PropertyDescriptor}
 */
function defaultProfileDecorator( target, propertyKey, descriptor ) {

	// Static methods receive the constructor itself as `target`.
	const className = ( typeof target === 'function' ? target.name : target.constructor?.name ) || 'Unknown';
	return applyProfileToMethod( `${className}.${String( propertyKey )}`, descriptor );

}

/**
 * Class decorator that profiles every method of the decorated class.
 *
 * @template T
 * @param {T} constructor
 * @return {T}
 */
function profileClass( constructor ) {

	const proto = constructor.prototype;
	for ( const key of Object.getOwnPropertyNames( proto ) ) {

		if ( key === 'constructor' ) continue;
		const descriptor = Object.getOwnPropertyDescriptor( proto, key );
		if ( ! descriptor || typeof descriptor.value !== 'function' ) continue;
		Object.defineProperty(
			proto,
			key,
			applyProfileToMethod( `${constructor.name}.${key}`, { ...descriptor } )
		);

	}

	return constructor;

}

export { ProfilerService, profile, profileClass };
// !WITH_GENESYS
