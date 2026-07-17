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
 *   __gnsx_profiler.reset()          // clear samples and trace
 *   __gnsx_profiler.disable()
 *
 * Chrome trace: `tid=1` is synchronous work; `@profile` on async methods records the
 * promise lifetime on `tid=2` so long async does not flatten the main row. For manual
 * spans, use `beginSpan` / `endSpan` with `{ asyncTimeline: true }` in a `.finally()`.
 */

const RING_SIZE = 120;
const FRAME_BUDGET_MS = 1000 / 60;
const TRACE_TID_MAIN = 1;
const TRACE_TID_ASYNC = 2;
const TRACE_TID_GPU = 3;
const NOOP = () => {};

const DUMMY_SPAN = Object.freeze( { label: '', t0: 0, _seq: 0 } );
const DUMMY_GPU_SPAN = Object.freeze( { label: '', renderer: null, t0: 0, _seq: 0, _generation: 0 } );
const NOOP_BEGIN_SPAN = () => DUMMY_SPAN;
const NOOP_END_SPAN = () => {};

const NOOP_BEGIN_GPU_SPAN = () => DUMMY_GPU_SPAN;

class ProfilerServiceClass {

	constructor() {

		this._profile = 'full';
		this._enabled = false;

		/** @type {Map<string, Float64Array>} Inclusive time ring buffers (one per label). */
		this.buffers = new Map();
		/** @type {Map<string, number>} */
		this.cursors = new Map();
		/** @type {Map<string, number>} */
		this.counts = new Map();
		/** @type {Map<string, Array<{ startTime: number, startMark: string }>>} */
		this.marks = new Map();
		/** @type {ChromeTraceEvent[]} */
		this.traceEvents = [];
		this.traceStartTime = 0;
		this._markId = 0;

		/** @type {Map<string, Float64Array>} Exclusive (self) time ring buffers (one per label). */
		this.selfBuffers = new Map();
		/** @type {Map<string, number>} */
		this.selfCursors = new Map();
		/** @type {Map<string, number>} */
		this.selfCounts = new Map();
		/**
		 * Global call stack tracking nesting across all labels for exclusive-time computation.
		 * @type {Array<{ label: string, childTime: number }>}
		 */
		this.callStack = [];
		/** @type {Map<string, number>} Total (uncapped) invocation count since last reset, for calls-per-frame. */
		this.invocations = new Map();

		/** @type {Map<string, Float64Array>} GPU time ring buffers (one per label). */
		this.gpuBuffers = new Map();
		/** @type {Map<string, number>} */
		this.gpuCursors = new Map();
		/** @type {Map<string, number>} */
		this.gpuCounts = new Map();
		/** @type {Map<string, number>} */
		this.gpuInvocations = new Map();
		/** @type {Map<Object, import('./ProfilerService.js').GpuRendererState>} */
		this.gpuRendererStates = new Map();
		this._gpuGeneration = 1;

		if ( this._enabled ) {

			this.traceStartTime = performance.now();
			this.begin = this._beginImpl.bind( this );
			this.end = this._endImpl.bind( this );
			this.beginSpan = this._beginSpanImpl.bind( this );
			this.endSpan = this._endSpanImpl.bind( this );
			this.beginGpu = this._beginGpuImpl.bind( this );
			this.endGpu = this._endGpuImpl.bind( this );
			this._exposeGlobal();
			console.log( `[ProfilerService] auto-started from env (profile: ${this._profile})` );

		} else {

			this.begin = NOOP;
			this.end = NOOP;
			this.beginSpan = NOOP_BEGIN_SPAN;
			this.endSpan = NOOP_END_SPAN;
			this.beginGpu = NOOP_BEGIN_GPU_SPAN;
			this.endGpu = NOOP_END_SPAN;

		}

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
		this._exposeGlobal();
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
	async attachGpuRenderer( renderer ) {

		if ( this._enabled === false || renderer === null || renderer === undefined ) return false;

		const existingState = this.gpuRendererStates.get( renderer );
		if ( existingState !== undefined ) return existingState.available;

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

			return state.available;

		}

		if ( renderer.isRenderer === true && renderer.backend !== undefined ) {

			await renderer.init();
			const previousTrackTimestamp = renderer.backend.trackTimestamp;
			renderer.backend.trackTimestamp = true;

			const available = renderer.backend.hasTimestamp === true && renderer.hasFeature( 'timestamp-query' ) === true;
			const listener = ( type, uid, label ) => this._captureGpuTimestampQuery( renderer, type, uid, label );
			const state = {
				kind: 'common',
				available,
				renderer,
				listener,
				previousTrackTimestamp,
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

				renderer.backend.addTimestampQueryListener( listener );

			} else {

				warnOnce( 'ProfilerService: Timestamp queries are unavailable; GPU profiling is disabled for this renderer.' );

			}

			return available;

		}

		warnOnce( 'ProfilerService: Unsupported renderer; expected Renderer or WebGLRenderer.' );
		return false;

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
			_generation: this._gpuGeneration,
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

		if ( handle._seq === 0 || handle._generation !== this._gpuGeneration ) return;

		const state = this.gpuRendererStates.get( handle.renderer );
		if ( state === undefined || state.available === false ) return;

		handle._endTime = performance.now();

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

		const cpuTime = performance.now();
		state.queryCpuTimes.set( uid, cpuTime );

		for ( const span of state.activeSpans ) {

			span._queries[ type ].add( uid );

		}

		if ( label !== null && label !== undefined && label !== '' ) {

			// Queue labelled passes with the active beginGpu span(s). Flushing
			// immediately would commit them before their parent envelope exists and
			// can anchor gpuTraceOrigin mid-frame, which breaks Speedscope nesting.
			const passSpan = {
				label: `GPU pass: ${label}`,
				renderer,
				t0: cpuTime,
				_seq: ++ this._markId,
				_generation: this._gpuGeneration,
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
		/** @type {Array<{ label: string, startTime: number, durationMs: number, isPass: boolean }>} */
		const samples = [];
		/** @type {Set<string>} */
		const labelledQueryUids = new Set();

		for ( const span of spans ) {

			if ( span._generation !== this._gpuGeneration ) continue;

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

			if ( resolvedQueries > 0 ) {

				let startTime = span.t0;
				// Prefer the device envelope whenever any query has a range. Requiring
				// *all* queries to be ranged forced a CPU-t0 + summed-duration fallback
				// that often ended before later GPU pass slices, breaking flame nesting.
				if ( rangedQueries > 0 && gpuStart !== null && gpuEnd !== null && state.gpuTimestampOrigin !== null ) {

					duration = Number( gpuEnd - gpuStart ) / 1e6;
					startTime = state.gpuTraceOrigin + Number( gpuStart - state.gpuTimestampOrigin ) / 1e6;

				}

				const isPass = span.label.startsWith( 'GPU pass:' );
				if ( isPass ) {

					for ( const type of [ TimestampQuery.RENDER, TimestampQuery.COMPUTE ] ) {

						for ( const uid of span._queries[ type ] ) labelledQueryUids.add( uid );

					}

				}

				samples.push( {
					label: span.label,
					startTime,
					durationMs: duration,
					isPass,
				} );

			}

		}

		// Parent beginGpu spans collect every timestamp query, including renders that
		// had no gpuProfilerLabel. Surface those as pass slices so they are not empty
		// holes under the parent envelope.
		for ( const span of spans ) {

			if ( span._generation !== this._gpuGeneration ) continue;
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
						isPass: true,
					} );
					labelledQueryUids.add( uid );

				}

			}

		}

		const passSamples = samples.filter( sample => sample.isPass );
		const otherSamples = samples.filter( sample => sample.isPass === false );
		this._snapHalfOpenGpuPassTraceIntervals( passSamples );
		this._expandGpuParentTraceToContainPasses( otherSamples, passSamples );

		for ( const sample of otherSamples ) {

			this._commitGpuDurationSample( sample.label, sample.startTime, sample.durationMs, {
				ts: sample.traceTs,
				dur: sample.traceDur,
			} );

		}

		for ( const sample of passSamples ) {

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

	}

	/**
	 * Convert labelled GPU pass samples to non-overlapping half-open µs intervals for
	 * Chrome/Speedscope traces. Stats keep the raw measured durations.
	 *
	 * @param {Array<{ startTime: number, durationMs: number, traceTs?: number, traceDur?: number }>} samples
	 */
	_snapHalfOpenGpuPassTraceIntervals( samples ) {

		if ( samples.length === 0 ) return;

		for ( const sample of samples ) {

			sample.traceTs = Math.round( this._getTraceTimestamp( sample.startTime ) );
			sample.traceDur = Math.max( 1, Math.round( sample.durationMs * 1000 ) );

		}

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
	 * Speedscope nests by time containment on a thread. If a snapped GPU pass
	 * sticks out past its beginGpu parent (rounding / half-open adjust), the
	 * parent fails containment and is pushed onto a lower lane under renderFrame.
	 * Expand overlapping parents so they strictly cover their pass children.
	 *
	 * @param {Array<{ startTime: number, durationMs: number, traceTs?: number, traceDur?: number }>} parents
	 * @param {Array<{ traceTs: number, traceDur: number }>} passes
	 */
	_expandGpuParentTraceToContainPasses( parents, passes ) {

		if ( parents.length === 0 || passes.length === 0 ) return;

		for ( const parent of parents ) {

			parent.traceTs = Math.round( this._getTraceTimestamp( parent.startTime ) );
			parent.traceDur = Math.max( 1, Math.round( parent.durationMs * 1000 ) );

			const parentEnd = parent.traceTs + parent.traceDur;
			let minTs = parent.traceTs;
			let maxEnd = parentEnd;
			let touched = false;

			for ( const pass of passes ) {

				const passEnd = pass.traceTs + pass.traceDur;
				if ( pass.traceTs >= parentEnd || passEnd <= parent.traceTs ) continue;

				touched = true;
				if ( pass.traceTs < minTs ) minTs = pass.traceTs;
				if ( passEnd > maxEnd ) maxEnd = passEnd;

			}

			if ( touched === false ) continue;

			// Start 1µs before the first child so equal-start pairs still nest
			// (Speedscope sorts same-ts by longer-first; a child that begins
			// strictly after the parent is unambiguous).
			parent.traceTs = minTs > 0 ? minTs - 1 : minTs;
			parent.traceDur = Math.max( 1, maxEnd - parent.traceTs );

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

			const duration = await this._resolveLegacyWebGLQuery( state, span._query );
			if ( duration !== null && span._generation === this._gpuGeneration && this._enabled ) {

				this._commitGpuDurationSample( span.label, span.t0, duration );

			}

		}

	}

	/**
	 * @param {import('./ProfilerService.js').LegacyWebGLGpuRendererState} state
	 * @param {WebGLQuery} query
	 * @return {Promise<?number>}
	 */
	_resolveLegacyWebGLQuery( state, query ) {

		return new Promise( resolve => {

			const poll = () => {

				if ( state.gl.isContextLost() ) {

					state.gl.deleteQuery( query );
					resolve( null );
					return;

				}

				const disjoint = state.gl.getParameter( state.extension.GPU_DISJOINT_EXT );
				const available = state.gl.getQueryParameter( query, state.gl.QUERY_RESULT_AVAILABLE );

				if ( available === false ) {

					setTimeout( poll, 1 );
					return;

				}

				const result = disjoint
					? null
					: Number( state.gl.getQueryParameter( query, state.gl.QUERY_RESULT ) ) / 1e6;
				state.gl.deleteQuery( query );
				resolve( result );

			};

			poll();

		} );

	}

	/**
	 * @param {string} label
	 */
	_beginImpl( label ) {

		const startTime = performance.now();
		const startMark = `gnsx:${label}:start:${++ this._markId}`;
		let stack = this.marks.get( label );
		if ( stack === undefined ) {

			stack = [];
			this.marks.set( label, stack );

		}

		performance.mark( startMark );
		stack.push( { startTime, startMark } );

		// Push onto the global call stack for exclusive-time tracking.
		this.callStack.push( { label, childTime: 0 } );

	}

	/**
	 * @param {string} label
	 */
	_endImpl( label ) {

		const stack = this.marks.get( label );
		const mark = stack?.pop();
		if ( mark === undefined ) return;
		if ( stack.length === 0 ) this.marks.delete( label );

		const now = performance.now();
		const { startTime, startMark } = mark;
		const duration = now - startTime;
		const endMark = `gnsx:${label}:end:${++ this._markId}`;

		performance.mark( endMark );
		performance.measure( `gnsx:${label}`, startMark, endMark );

		this._commitDurationSample( label, startTime, duration, TRACE_TID_MAIN );

	}

	/**
	 * Per-invocation span start (pair with {@link ProfilerServiceClass#endSpan}).
	 * Safe for concurrent async with the same label.
	 *
	 * @param {string} label
	 * @return {import('./ProfilerService.js').SpanHandle}
	 */
	_beginSpanImpl( label ) {

		const seq = ++ this._markId;
		const t0 = performance.now();
		const startMark = `gnsx:${label}:s${seq}:start`;
		performance.mark( startMark );
		return { label, t0, _seq: seq, _startMark: startMark };

	}

	/**
	 * @param {import('./ProfilerService.js').SpanHandle} handle
	 * @param {import('./ProfilerService.js').EndSpanOptions} [opts]
	 */
	_endSpanImpl( handle, opts ) {

		if ( handle._seq === 0 ) return;

		const now = performance.now();
		const duration = now - handle.t0;
		const endMark = `gnsx:${handle.label}:s${handle._seq}:end`;
		performance.mark( endMark );
		performance.measure( `gnsx:${handle.label}#${handle._seq}`, handle._startMark, endMark );

		const traceTid = opts?.asyncTimeline === true ? TRACE_TID_ASYNC : TRACE_TID_MAIN;
		this._commitDurationSample( handle.label, handle.t0, duration, traceTid );

	}

	/**
	 * @param {string} label
	 * @param {number} startTime
	 * @param {number} durationMs
	 * @param {typeof TRACE_TID_MAIN|typeof TRACE_TID_ASYNC} traceTid
	 */
	_commitDurationSample( label, startTime, durationMs, traceTid ) {

		let buffer = this.buffers.get( label );
		if ( ! buffer ) {

			buffer = new Float64Array( RING_SIZE );
			this.buffers.set( label, buffer );
			this.cursors.set( label, 0 );
			this.counts.set( label, 0 );

		}

		const cursor = this.cursors.get( label );
		buffer[ cursor ] = durationMs;
		this.cursors.set( label, ( cursor + 1 ) % RING_SIZE );
		this.counts.set( label, Math.min( ( this.counts.get( label ) + 1 ), RING_SIZE ) );

		// Track total invocations (uncapped) for calls-per-frame computation.
		this.invocations.set( label, ( this.invocations.get( label ) ?? 0 ) + 1 );

		// Exclusive (self) time via the global call stack.
		const top = this.callStack.length > 0 ? this.callStack[ this.callStack.length - 1 ] : undefined;
		if ( top !== undefined && top.label === label ) {

			this.callStack.pop();
			const selfTime = Math.max( 0, durationMs - top.childTime );

			let selfBuffer = this.selfBuffers.get( label );
			if ( ! selfBuffer ) {

				selfBuffer = new Float64Array( RING_SIZE );
				this.selfBuffers.set( label, selfBuffer );
				this.selfCursors.set( label, 0 );
				this.selfCounts.set( label, 0 );

			}

			const selfCursor = this.selfCursors.get( label );
			selfBuffer[ selfCursor ] = selfTime;
			this.selfCursors.set( label, ( selfCursor + 1 ) % RING_SIZE );
			this.selfCounts.set( label, Math.min( ( this.selfCounts.get( label ) + 1 ), RING_SIZE ) );

			// Propagate inclusive duration to the parent scope's child accumulator.
			const parent = this.callStack.length > 0 ? this.callStack[ this.callStack.length - 1 ] : undefined;
			if ( parent !== undefined ) parent.childTime += durationMs;

		} else {

			// Label mismatch — likely async interleaving. Reset to avoid corruption.
			this.callStack.length = 0;

		}

		if ( traceTid ) {

			const traceName = traceTid === TRACE_TID_ASYNC ? `${label} (promise)` : label;
			this.traceEvents.push( {
				name: traceName,
				ph: 'X',
				ts: Math.round( this._getTraceTimestamp( startTime ) ),
				dur: Math.max( 1, Math.round( durationMs * 1000 ) ),
				pid: 1,
				tid: traceTid,
				cat: 'gnsx',
			} );

		}

	}

	/**
	 * @param {string} label
	 * @param {number} startTime
	 * @param {number} durationMs
	 * @param {{ ts: number, dur: number }} [traceOverride]
	 */
	_commitGpuDurationSample( label, startTime, durationMs, traceOverride = null ) {

		let buffer = this.gpuBuffers.get( label );
		if ( buffer === undefined ) {

			buffer = new Float64Array( RING_SIZE );
			this.gpuBuffers.set( label, buffer );
			this.gpuCursors.set( label, 0 );
			this.gpuCounts.set( label, 0 );

		}

		const cursor = this.gpuCursors.get( label );
		buffer[ cursor ] = durationMs;
		this.gpuCursors.set( label, ( cursor + 1 ) % RING_SIZE );
		this.gpuCounts.set( label, Math.min( this.gpuCounts.get( label ) + 1, RING_SIZE ) );
		this.gpuInvocations.set( label, ( this.gpuInvocations.get( label ) ?? 0 ) + 1 );

		if ( this._profile === 'full' ) {

			this.traceEvents.push( {
				name: label,
				ph: 'X',
				ts: traceOverride?.ts ?? Math.round( this._getTraceTimestamp( startTime ) ),
				dur: traceOverride?.dur ?? Math.max( 1, Math.round( durationMs * 1000 ) ),
				pid: 1,
				tid: TRACE_TID_GPU,
				cat: 'gnsx-gpu',
			} );

		}

	}

	/**
	 * @param {string} label
	 * @return {number[]}
	 */
	getValidSamples( label ) {

		const buffer = this.buffers.get( label );
		const count = this.counts.get( label ) ?? 0;
		if ( ! buffer || count === 0 ) return [];
		return count < RING_SIZE
			? Array.from( buffer.subarray( 0, count ) )
			: Array.from( buffer );

	}

	/**
	 * @param {string} label
	 * @return {number[]}
	 */
	getValidGpuSamples( label ) {

		const buffer = this.gpuBuffers.get( label );
		const count = this.gpuCounts.get( label ) ?? 0;
		if ( buffer === undefined || count === 0 ) return [];
		return count < RING_SIZE
			? Array.from( buffer.subarray( 0, count ) )
			: Array.from( buffer );

	}

	/**
	 * @param {string} label
	 * @return {import('./ProfilerService.js').ProfilerStats|null}
	 */
	getStats( label ) {

		const samples = this.getValidSamples( label );
		if ( samples.length === 0 ) return null;

		const sorted = [ ...samples ].sort( ( a, b ) => a - b );
		const avg = sorted.reduce( ( a, b ) => a + b, 0 ) / sorted.length;

		// Exclusive (self) time stats.
		const selfCount = this.selfCounts.get( label ) ?? 0;
		let selfAvg, selfMin, selfMax, selfP95, selfFrameBudget;
		if ( selfCount > 0 ) {

			const selfBuffer = this.selfBuffers.get( label );
			const selfSamples = [ ...( selfCount < RING_SIZE
				? selfBuffer.subarray( 0, selfCount )
				: selfBuffer ) ].sort( ( a, b ) => a - b );
			selfAvg = selfSamples.reduce( ( a, b ) => a + b, 0 ) / selfSamples.length;
			selfMin = selfSamples[ 0 ];
			selfMax = selfSamples[ selfSamples.length - 1 ];
			selfP95 = selfSamples[ Math.floor( selfSamples.length * 0.95 ) ];
			selfFrameBudget = ( selfAvg / FRAME_BUDGET_MS ) * 100;

		}

		return {
			label,
			samples: samples.length,
			avg,
			min: sorted[ 0 ],
			max: sorted[ sorted.length - 1 ],
			p95: sorted[ Math.floor( sorted.length * 0.95 ) ],
			frameBudget: ( avg / FRAME_BUDGET_MS ) * 100,
			totalInvocations: this.invocations.get( label ) ?? 0,
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

		const sorted = [ ...samples ].sort( ( a, b ) => a - b );
		const avg = sorted.reduce( ( a, b ) => a + b, 0 ) / sorted.length;

		return {
			label,
			samples: samples.length,
			avg,
			min: sorted[ 0 ],
			max: sorted[ sorted.length - 1 ],
			p95: sorted[ Math.floor( sorted.length * 0.95 ) ],
			frameBudget: ( avg / FRAME_BUDGET_MS ) * 100,
			totalInvocations: this.gpuInvocations.get( label ) ?? 0,
		};

	}

	/**
	 * @return {import('./ProfilerService.js').ProfilerStats[]}
	 */
	getAllStats() {

		return [ ...this.buffers.keys() ]
			.map( label => this.getStats( label ) )
			.filter( s => s !== null );

	}

	/**
	 * @return {import('./ProfilerService.js').GpuProfilerStats[]}
	 */
	getAllGpuStats() {

		return [ ...this.gpuBuffers.keys() ]
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
				'min ms': s.min.toFixed( 3 ),
				'max ms': s.max.toFixed( 3 ),
				'p95 ms': s.p95.toFixed( 3 ),
				'budget %': s.frameBudget.toFixed( 1 ) + '%',
				samples: s.samples,
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
				} ) )
			);

		}

	}

	/**
	 * @return {import('./ProfilerService.js').ChromeTrace}
	 */
	exportChromeTrace() {

		const slices = [ ...this.traceEvents ];
		slices.sort( ( a, b ) => {

			if ( a.ts !== b.ts ) return a.ts - b.ts;
			if ( a.tid !== b.tid ) return a.tid - b.tid;
			return a.name.localeCompare( b.name );

		} );
		const hasAsync = slices.some( e => e.tid === TRACE_TID_ASYNC );
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
		if ( hasAsync ) {

			prefix.push( {
				cat: '__metadata',
				name: 'thread_name',
				ph: 'M',
				pid: 1,
				tid: TRACE_TID_ASYNC,
				ts: 0,
				args: { name: 'Async (promise lifetime)' },
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
	 * @param {number} time
	 * @return {number}
	 */
	_getTraceTimestamp( time ) {

		return ( time - this.traceStartTime ) * 1000;

	}

	/**
	 * @param {string} [filename='gnsx-trace.json']
	 */
	downloadTrace( filename = 'gnsx-trace.json' ) {

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

		const json = JSON.stringify( this.exportChromeTrace() );
		const blob = new Blob( [ json ], { type: 'application/json' } );
		const url = URL.createObjectURL( blob );
		const a = document.createElement( 'a' );
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL( url );
		console.log( `[ProfilerService] Trace downloaded: ${filename} (${this.traceEvents.length} events)` );

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

		this._gpuGeneration ++;
		for ( const state of this.gpuRendererStates.values() ) {

			this._clearGpuRendererState( state );

		}

		this.buffers.clear();
		this.cursors.clear();
		this.counts.clear();
		this.marks.clear();
		this.traceEvents = [];
		this.traceStartTime = performance.now();
		this._markId = 0;
		this.selfBuffers.clear();
		this.selfCursors.clear();
		this.selfCounts.clear();
		this.callStack.length = 0;
		this.invocations.clear();
		this.gpuBuffers.clear();
		this.gpuCursors.clear();
		this.gpuCounts.clear();
		this.gpuInvocations.clear();

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

		if ( state.flushPromise === null ) {

			for ( const span of state.pendingSpans ) {

				state.gl.deleteQuery( span._query );

			}

		}

		state.pendingSpans.length = 0;

	}

	_detachGpuRenderers() {

		for ( const state of this.gpuRendererStates.values() ) {

			if ( state.kind === 'common' && state.available ) {

				state.renderer.backend.removeTimestampQueryListener( state.listener );

			}

			if ( state.kind === 'common' ) {

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
 * @property {number} samples
 * @property {number} avg
 * @property {number} min
 * @property {number} max
 * @property {number} p95
 * @property {number} frameBudget Percentage of a 60 fps frame budget (16.67 ms)
 * @property {number} totalInvocations Total (uncapped) call count since last reset, for calls-per-frame computation.
 * @property {number|undefined} selfAvg Exclusive (self) avg ms — inclusive time minus child scope time.
 * @property {number|undefined} selfMin
 * @property {number|undefined} selfMax
 * @property {number|undefined} selfP95
 * @property {number|undefined} selfFrameBudget Exclusive time as percentage of a 60 fps frame budget.
 */

/**
 * @typedef {Object} GpuProfilerStats
 * @property {string} label
 * @property {number} samples
 * @property {number} avg
 * @property {number} min
 * @property {number} max
 * @property {number} p95
 * @property {number} frameBudget Percentage of a 60 fps frame budget (16.67 ms)
 * @property {number} totalInvocations
 */

/**
 * @typedef {Object} SpanHandle
 * @property {string} label
 * @property {number} t0
 * @property {number} _seq
 * @property {string} _startMark
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
 * @property {number} [_endTime]
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

function isThenable( x ) {

	return (
		( typeof x === 'object' || typeof x === 'function' ) &&
		x !== null &&
		typeof x.then === 'function'
	);

}

function applyProfileToMethod( label, descriptor ) {

	const original = descriptor.value;

	function profiled( ...args ) {

		const span = ProfilerService.beginSpan( label );
		try {

			const result = original.apply( this, args );
			if ( isThenable( result ) ) {

				return Promise.resolve( result ).finally( () => ProfilerService.endSpan( span, { asyncTimeline: true } ) );

			}

			ProfilerService.endSpan( span );
			return result;

		} catch ( error ) {

			ProfilerService.endSpan( span );
			throw error;

		}

	}

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

	const className = target.constructor?.name ?? 'Unknown';
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
