// WITH_GENESYS
import { warnOnce } from '../utils.js';
import { PassTimestampLevel } from './PassTimestampLevel.js';
import { DUMMY_GPU_SPAN, WebGLTimer, WebGPUTimer } from './ProfilerGpu.js';
import { TRACE_TID_ASYNC, TRACE_TID_GPU, TRACE_TID_MAIN, TraceBuffer, buildChromeTrace } from './ProfilerTrace.js';

/**
 * @typedef {Object} TraceSink
 * @property {(event: {name: string, ph: 'X', ts: number, dur: number, pid: 1, tid: number, cat: 'gnsx'|'gnsx-gpu', args: {depth: number}}) => void} write
 * @property {(() => void)=} close
 */

/**
 * @typedef {Object} SessionDurationStats
 * @property {number} count
 * @property {number} totalMs
 * @property {number} min
 * @property {number} max
 */

/**
 * @typedef {Object} SessionStats
 * @property {string} label
 * @property {number} count
 * @property {number} totalMs
 * @property {number} min
 * @property {number} max
 * @property {number=} selfCount
 * @property {number=} selfTotalMs
 * @property {number=} selfMin
 * @property {number=} selfMax
 */

/**
 * @typedef {Object} GpuSessionStats
 * @property {string} label
 * @property {number} count
 * @property {number} totalMs
 * @property {number} min
 * @property {number} max
 */

/**
 * ProfilerService — per-label CPU timing with ring-buffer aggregation and Chrome trace export.
 *
 * Quick start (browser console):
 *   __gnsx_profiler.enable()
 *   // play for a few seconds
 *   __gnsx_profiler.report()         // sorted console.table (aggregated stats)
 *   __gnsx_profiler.downloadTrace()  // download gnsx-trace.json for Speedscope / Perfetto
 *   __gnsx_profiler.downloadTrace('gnsx-trace.json', 0.05)  // omit spans < 0.05 ms
 *   __gnsx_profiler.setTraceSink(sink) // stream slices instead of retaining them
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
 * Profiles: `'full'` keeps a Chrome trace; `'stats'` keeps the ring buffers. Trace slices are
 * also emitted while {@link ProfilerServiceClass#beginTraceCapture} is active, including in
 * `'stats'`, so a streamed trace does not reset the rings.
 */

const RING_SIZE = 120;
const FRAME_BUDGET_MS = 1000 / 60;
const MAX_TRACE_EVENTS = 500000;
/** Scopes left open per label (early return, exception) that a late `end()` can still close. */
const MAX_ORPHANS = 16;
const NOOP = () => {};

const GPU_DETAIL_LEVELS = Object.freeze( {
	pass: PassTimestampLevel.OFF,
	stage: PassTimestampLevel.STAGE,
	draw: PassTimestampLevel.DRAW
} );

const DUMMY_SPAN = Object.freeze( { label: '', t0: 0, _seq: 0, _generation: 0 } );
const NOOP_BEGIN_SPAN = () => DUMMY_SPAN;
const NOOP_BEGIN_GPU_SPAN = () => DUMMY_GPU_SPAN;

class ProfilerServiceClass {

	constructor() {

		this._profile = 'full';
		this._gpuDetail = 'pass';
		this._enabled = false;
		/** Trace events kept per session in the `'full'` profile. */
		this.maxTraceEvents = MAX_TRACE_EVENTS;
		/** Budget that `frameBudget` percentages are computed against (ms). */
		this.frameBudgetMs = FRAME_BUDGET_MS;

		/** @type {Map<string, SampleRecord>} */
		this._records = new Map();
		/** @type {Map<string, SampleRecord>} */
		this._gpuRecords = new Map();
		this._trace = new TraceBuffer();
		this._traceStartTime = 0;
		/** Trace capture is independent from bounded stats collection. */
		this._traceCaptureEnabled = false;
		/** @type {TraceSink|null} */
		this._traceSink = null;
		/** Spans shorter than this are omitted from the trace. Stats and session totals still record them. */
		this._traceMinDurationMs = 0;
		/** @type {Map<string, SessionDurationStats>} Inclusive totals for the whole session, not the ring. */
		this.sessionTotals = new Map();
		/** @type {Map<string, SessionDurationStats>} */
		this.sessionSelfTotals = new Map();
		/** @type {Map<string, SessionDurationStats>} */
		this.sessionGpuTotals = new Map();

		/**
		 * Open scopes and synchronous spans, innermost last. Frames are reused: only
		 * `_stack[ 0 .. _depth )` is open.
		 * @type {Frame[]}
		 */
		this._stack = [];
		this._depth = 0;
		/** Span id counter; `0` marks scope frames and no-op handles. */
		this._seq = 0;
		/** Session counter: span handles from an earlier session are ignored. */
		this._generation = 1;

		/** @type {Map<Object, WebGPUTimer|WebGLTimer>} */
		this._gpuTimers = new Map();
		/** @type {Map<Object, Promise<boolean>>} Common-renderer attaches waiting on `renderer.init()`. */
		this._gpuAttachments = new Map();

		this._bindNoops();

		if ( typeof window !== 'undefined' ) window.__gnsx_profiler = this;

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

	/**
	 * Route complete trace slices to `sink` instead of retaining them in the trace buffer.
	 * `disable()` calls `sink.close` before clearing stats. `enable()` and `reset()` do not.
	 *
	 * @param {TraceSink|null} sink
	 */
	setTraceSink( sink ) {

		if ( sink === this._traceSink ) return;

		this._closeTraceSink();
		this._traceSink = sink ?? null;

	}

	/**
	 * Drop complete spans shorter than this from the trace. Unlike {@link ProfilerServiceClass#exportChromeTrace},
	 * discarded spans are not recoverable. `0` keeps every span. Stats rings and session totals are unaffected.
	 *
	 * @param {number} minDurationMs
	 */
	setTraceMinDurationMs( minDurationMs ) {

		const value = Number( minDurationMs );
		this._traceMinDurationMs = Number.isFinite( value ) && value > 0 ? value : 0;

	}

	/**
	 * @return {number}
	 */
	getTraceMinDurationMs() {

		return this._traceMinDurationMs;

	}

	/**
	 * Start a fresh trace session without clearing bounded stats rings.
	 * Enables profiling when it is off. The sink may be installed before or after this call.
	 */
	beginTraceCapture() {

		if ( this._enabled === false ) this.enable();
		this._clearTraceState();
		this._traceCaptureEnabled = true;

	}

	/**
	 * Stop emitting trace events without disabling bounded stats collection.
	 * Session totals and retained events remain readable until the next trace or reset.
	 */
	endTraceCapture() {

		this._closeTraceSink();
		this._traceCaptureEnabled = false;

	}

	/**
	 * @return {boolean}
	 */
	isTraceCaptureEnabled() {

		return this._traceCaptureEnabled;

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

		try {

			this._closeTraceSink();

		} finally {

			this._traceCaptureEnabled = false;
			this._clearState();

		}

		this._enabled = false;
		this._bindNoops();
		for ( const timer of this._gpuTimers.values() ) timer.detach();
		this._gpuTimers.clear();
		console.log( '[ProfilerService] disabled' );

	}

	isEnabled() {

		return this._enabled;

	}

	/**
	 * Whether a trace is being recorded, i.e. `begin()` trace names are used. Call sites
	 * should only build a trace name when this is true. True for the `'full'` profile and
	 * while {@link ProfilerServiceClass#beginTraceCapture} is active.
	 *
	 * @return {boolean}
	 */
	isTracing() {

		return this._enabled && ( this._profile === 'full' || this._traceCaptureEnabled );

	}

	reset() {

		this._clearState();
		console.log( '[ProfilerService] data reset' );

	}

	_bindNoops() {

		this.begin = NOOP;
		this.end = NOOP;
		this.beginSpan = NOOP_BEGIN_SPAN;
		this.endSpan = NOOP;
		this.beginGpu = NOOP_BEGIN_GPU_SPAN;
		this.endGpu = NOOP;

	}

	_clearState() {

		this._generation ++;
		this._records.clear();
		this._gpuRecords.clear();
		this._clearTraceState();
		this._depth = 0;
		for ( const timer of this._gpuTimers.values() ) timer.clear();

	}

	/**
	 * Drop retained slices and session totals. Bounded stats rings are left alone.
	 */
	_clearTraceState() {

		this._trace.clear();
		this._traceStartTime = performance.now();
		this.sessionTotals.clear();
		this.sessionSelfTotals.clear();
		this.sessionGpuTotals.clear();

	}

	_closeTraceSink() {

		const sink = this._traceSink;
		if ( sink === null ) return;

		this._traceSink = null;
		if ( typeof sink.close === 'function' ) sink.close();

	}

	/**
	 * @param {Map<string, SessionDurationStats>} totals
	 * @param {string} label
	 * @param {number} durationMs
	 */
	_accumulateSession( totals, label, durationMs ) {

		let stats = totals.get( label );
		if ( stats === undefined ) {

			stats = { count: 0, totalMs: 0, min: Infinity, max: - Infinity };
			totals.set( label, stats );

		}

		stats.count ++;
		stats.totalMs += durationMs;
		if ( durationMs < stats.min ) stats.min = durationMs;
		if ( durationMs > stats.max ) stats.max = durationMs;

	}

	// CPU scopes and spans

	/**
	 * @param {string} label Stats key; keep it stable so samples aggregate.
	 * @param {string} [traceName] Trace slice name, defaulting to `label`. Can carry per-call
	 * context such as object names; build it only when {@link ProfilerServiceClass#isTracing}.
	 */
	_beginImpl( label, traceName ) {

		const frame = this._pushFrame( this._getRecord( label ), 0, traceName ?? label );
		frame.t0 = performance.now();

	}

	/**
	 * @param {string} label
	 */
	_endImpl( label ) {

		const now = performance.now();
		const top = this._depth - 1;
		if ( top >= 0 ) {

			const frame = this._stack[ top ];
			if ( frame.seq === 0 && frame.record.label === label ) {

				this._closeTop( now );
				return;

			}

		}

		this._endUnbalanced( label, now );

	}

	/**
	 * Per-invocation span start (pair with {@link ProfilerServiceClass#endSpan}).
	 * Safe for concurrent async with the same label.
	 *
	 * @param {string} label
	 * @param {BeginSpanOptions} [opts]
	 * @return {SpanHandle}
	 */
	_beginSpanImpl( label, opts ) {

		const seq = ++ this._seq;
		const handle = { label, t0: 0, _seq: seq, _generation: this._generation };
		const frame = opts?.asyncTimeline === true ? null : this._pushFrame( this._getRecord( label ), seq, label );
		handle.t0 = performance.now();
		if ( frame !== null ) frame.t0 = handle.t0;
		return handle;

	}

	/**
	 * @param {SpanHandle} handle
	 * @param {EndSpanOptions} [opts]
	 */
	_endSpanImpl( handle, opts ) {

		const seq = handle._seq;
		if ( seq === 0 || handle._generation !== this._generation ) return;

		// An ended handle is inert, like one from beginSpan() while disabled.
		handle._seq = 0;
		const now = performance.now();

		if ( opts?.asyncTimeline === true ) {

			// Async completions land at arbitrary times: drop the span's frame without
			// touching the scopes that are open right now.
			const index = this._findSpanFrame( seq );
			if ( index !== - 1 ) this._removeFrameAt( index );
			this._commit( this._getRecord( handle.label ), handle.t0, now - handle.t0, NaN, true, `${handle.label} (promise)`, TRACE_TID_ASYNC, 0 );
			return;

		}

		const top = this._depth - 1;
		if ( top >= 0 && this._stack[ top ].seq === seq ) {

			this._closeTop( now );
			return;

		}

		const index = this._findSpanFrame( seq );
		if ( index !== - 1 ) {

			this._closeFrameAt( index, now );
			return;

		}

		// The span has no frame: it began with `asyncTimeline`, or its frame was detached.
		this._warnOutOfOrder( handle.label );
		this._commit( this._getRecord( handle.label ), handle.t0, now - handle.t0, NaN, true, `${handle.label} (out of order)`, TRACE_TID_ASYNC, 0 );

	}

	/**
	 * Removes a span's frame once its synchronous part has finished, so later sibling scopes
	 * are attributed to the real parent. No-op for dummy and stale handles.
	 *
	 * @param {SpanHandle} handle
	 */
	_detachSpanFrame( handle ) {

		if ( handle._seq === 0 || handle._generation !== this._generation ) return;

		const index = this._findSpanFrame( handle._seq );
		if ( index !== - 1 ) this._removeFrameAt( index );

	}

	/**
	 * @param {SampleRecord} record
	 * @param {number} seq
	 * @param {string} traceName
	 * @return {Frame}
	 */
	_pushFrame( record, seq, traceName ) {

		let frame = this._stack[ this._depth ];
		if ( frame === undefined ) {

			frame = { record, seq, t0: 0, childTime: 0, traceName };
			this._stack.push( frame );

		} else {

			frame.record = record;
			frame.seq = seq;
			frame.childTime = 0;
			frame.traceName = traceName;

		}

		this._depth ++;
		record.open ++;
		return frame;

	}

	/**
	 * Closes the innermost frame — the common case.
	 *
	 * @param {number} now
	 */
	_closeTop( now ) {

		const depth = -- this._depth;
		const frame = this._stack[ depth ];
		const record = frame.record;
		const duration = now - frame.t0;
		if ( depth > 0 ) this._stack[ depth - 1 ].childTime += duration;

		// A call nested in an open call with the same label is already inside that call's
		// inclusive time, so only its self time is recorded.
		const inclusive = -- record.open === 0;
		this._commit( record, frame.t0, duration, Math.max( 0, duration - frame.childTime ), inclusive, frame.traceName, TRACE_TID_MAIN, depth );

	}

	/**
	 * `end( label )` for a scope that is not the innermost frame.
	 *
	 * @param {string} label
	 * @param {number} now
	 */
	_endUnbalanced( label, now ) {

		const record = this._records.get( label );
		if ( record === undefined ) return;

		for ( let i = this._depth - 1; i >= 0; i -- ) {

			const frame = this._stack[ i ];
			if ( frame.seq === 0 && frame.record === record ) {

				this._closeFrameAt( i, now );
				return;

			}

		}

		// An enclosing scope or span ended first and left this scope behind.
		const orphan = record.orphans.pop();
		if ( orphan === undefined ) return;

		// Frames that began before it are the calls it was nested in. Work that ran after it
		// was parked is not subtracted, so it has no self time.
		let inclusive = true;
		for ( let i = 0; i < this._depth; i ++ ) {

			const frame = this._stack[ i ];
			if ( frame.record === record && frame.t0 <= orphan.t0 ) inclusive = false;

		}

		this._warnOutOfOrder( label );
		this._commit( record, orphan.t0, now - orphan.t0, NaN, inclusive, `${orphan.traceName} (out of order)`, TRACE_TID_ASYNC, 0 );

	}

	/**
	 * Closes frame `index` while frames above it are still open. Open spans above it always end
	 * later (`@profile` closes them in `finally`), so they now nest in the parent and this frame
	 * goes to the async row. Scopes above it never ended (early return, exception) and are
	 * dropped, though a late `end()` still records them out of order.
	 *
	 * @param {number} index
	 * @param {number} now
	 */
	_closeFrameAt( index, now ) {

		const stack = this._stack;
		const frame = stack[ index ];
		const { record, t0, traceName } = frame;
		const duration = now - t0;
		const parent = index > 0 ? stack[ index - 1 ] : null;

		let inclusive = true;
		for ( let i = 0; i < index; i ++ ) {

			if ( stack[ i ].record === record ) inclusive = false;

		}

		let hasSpanAbove = false;
		for ( let i = index + 1; i < this._depth; i ++ ) {

			if ( stack[ i ].seq !== 0 ) hasSpanAbove = true;

		}

		if ( hasSpanAbove ) {

			// Credit the parent only with the time before the next frame started, so the
			// overlap is not counted twice.
			const exclusive = Math.max( 0, stack[ index + 1 ].t0 - t0 );
			const selfTime = Math.max( 0, exclusive - frame.childTime );
			if ( parent !== null ) parent.childTime += exclusive;
			this._removeFrameAt( index );
			this._warnOutOfOrder( record.label );
			this._commit( record, t0, duration, selfTime, inclusive, `${traceName} (out of order)`, TRACE_TID_ASYNC, 0 );
			return;

		}

		for ( let i = index + 1; i < this._depth; i ++ ) {

			const orphan = stack[ i ];
			const orphans = orphan.record.orphans;
			orphan.record.open --;
			if ( orphans.length === MAX_ORPHANS ) orphans.shift();
			orphans.push( { t0: orphan.t0, traceName: orphan.traceName } );

		}

		this._depth = index;
		record.open --;
		if ( parent !== null ) parent.childTime += duration;
		this._commit( record, t0, duration, Math.max( 0, duration - frame.childTime ), inclusive, traceName, TRACE_TID_MAIN, index );

	}

	/**
	 * Removes frame `index` and keeps the frames above it open.
	 *
	 * @param {number} index
	 */
	_removeFrameAt( index ) {

		const stack = this._stack;
		const frame = stack[ index ];
		const last = -- this._depth;
		for ( let i = index; i < last; i ++ ) stack[ i ] = stack[ i + 1 ];
		stack[ last ] = frame;
		frame.record.open --;

	}

	/**
	 * @param {number} seq
	 * @return {number} Index of the open span frame with `seq`, or -1.
	 */
	_findSpanFrame( seq ) {

		for ( let i = this._depth - 1; i >= 0; i -- ) {

			if ( this._stack[ i ].seq === seq ) return i;

		}

		return - 1;

	}

	/**
	 * @param {string} label
	 */
	_warnOutOfOrder( label ) {

		warnOnce( `ProfilerService: "${label}" did not nest inside the scopes and spans around it and is recorded on the async row. Pass { asyncTimeline: true } to beginSpan() and endSpan() for work that outlives its caller.` );

	}

	/**
	 * @param {string} label
	 * @return {SampleRecord}
	 */
	_getRecord( label ) {

		let record = this._records.get( label );
		if ( record === undefined ) {

			record = createRecord( label, true );
			this._records.set( label, record );

		}

		return record;

	}

	/**
	 * @param {SampleRecord} record
	 * @param {number} startTime
	 * @param {number} durationMs
	 * @param {number} selfTime Exclusive time, or `NaN` when the sample has none.
	 * @param {boolean} inclusive Whether `durationMs` counts towards inclusive stats.
	 * @param {string} traceName
	 * @param {number} tid
	 * @param {number} depth
	 */
	_commit( record, startTime, durationMs, selfTime, inclusive, traceName, tid, depth ) {

		pushSample( record, inclusive ? durationMs : NaN, selfTime );

		if ( this._traceCaptureEnabled || this._profile === 'full' ) {

			this._accumulateSession( this.sessionTotals, record.label, durationMs );
			if ( Number.isFinite( selfTime ) ) this._accumulateSession( this.sessionSelfTotals, record.label, selfTime );

			// Rounding both endpoints keeps rounded children inside their rounded parent.
			const ts = Math.round( this._toTraceUs( startTime ) );
			this._pushTraceSlice( traceName, ts, Math.round( this._toTraceUs( startTime + durationMs ) ) - ts, tid, depth );

		}

	}

	/**
	 * Sub-µs slices are left out: padding them to 1 µs can push them past their parent.
	 *
	 * @param {string} name
	 * @param {number} ts
	 * @param {number} dur
	 * @param {number} tid
	 * @param {number} depth
	 */
	_pushTraceSlice( name, ts, dur, tid, depth ) {

		if ( dur <= 0 ) return;
		if ( this._traceMinDurationMs > 0 && dur < this._traceMinDurationMs * 1000 ) return;

		if ( this._traceSink !== null ) {

			this._traceSink.write( {
				name,
				ph: 'X',
				ts,
				dur,
				pid: 1,
				tid,
				cat: tid === TRACE_TID_GPU ? 'gnsx-gpu' : 'gnsx',
				args: { depth },
			} );
			return;

		}

		if ( this._trace.length >= this.maxTraceEvents ) {

			warnOnce( `ProfilerService: Trace limit reached (${this.maxTraceEvents} events); later events are dropped. Call reset() or downloadTrace() sooner.` );
			return;

		}

		this._trace.push( name, ts, dur, tid, depth );

	}

	/**
	 * @param {number} time `performance.now()` time (ms).
	 * @return {number} Trace time (µs).
	 */
	_toTraceUs( time ) {

		return ( time - this._traceStartTime ) * 1000;

	}

	// GPU

	/**
	 * Sets how finely GPU work is timed in render passes. `'stage'` adds opaque, transparent
	 * and bundle spans; `'draw'` adds a span per draw as well. Both need timestamps inside
	 * passes ({@link ProfilerServiceClass#hasPassTimestamps}); without them only whole passes
	 * are timed. Per-draw timing adds GPU overhead, so use it to locate cost, not to measure
	 * frame time.
	 *
	 * @param {'pass'|'stage'|'draw'} detail
	 */
	setGpuDetail( detail ) {

		if ( typeof GPU_DETAIL_LEVELS[ detail ] !== 'number' ) {

			warnOnce( `ProfilerService: Unknown GPU detail "${detail}"; expected 'pass', 'stage' or 'draw'.` );
			return;

		}

		this._gpuDetail = detail;
		for ( const timer of this._gpuTimers.values() ) {

			if ( timer instanceof WebGPUTimer === false ) continue;
			timer.setPassTimestampLevel( this._passTimestampLevel );
			this._warnIfPassTimestampsUnsupported( timer );

		}

	}

	/**
	 * @param {WebGPUTimer} timer
	 */
	_warnIfPassTimestampsUnsupported( timer ) {

		if ( this._gpuDetail === 'pass' || timer.available === false || timer.supportsPassTimestamps ) return;
		warnOnce( `ProfilerService: GPU detail "${this._gpuDetail}" needs timestamps inside passes; only whole passes are timed. In Chrome, enable chrome://flags/#enable-unsafe-webgpu (or --enable-unsafe-webgpu).` );

	}

	/**
	 * @return {'pass'|'stage'|'draw'}
	 */
	getGpuDetail() {

		return this._gpuDetail;

	}

	/** @type {number} {@link PassTimestampLevel} for the current GPU detail. */
	get _passTimestampLevel() {

		return GPU_DETAIL_LEVELS[ this._gpuDetail ];

	}

	/**
	 * Whether a renderer can time stages and draws inside passes. In Chrome this needs
	 * chrome://flags/#enable-unsafe-webgpu (or `--enable-unsafe-webgpu`). False until
	 * `renderer.init()` resolves.
	 *
	 * @param {Object} renderer
	 * @return {boolean}
	 */
	hasPassTimestamps( renderer ) {

		return renderer?.backend?.supportsPassTimestamps === true;

	}

	/**
	 * Enables GPU timestamp collection for a renderer.
	 *
	 * @param {Object} renderer
	 * @return {Promise<boolean>} Whether GPU timestamps are available.
	 */
	attachGpuRenderer( renderer ) {

		if ( this._enabled === false || renderer === null || renderer === undefined ) return Promise.resolve( false );

		const timer = this._gpuTimers.get( renderer );
		if ( timer !== undefined ) return Promise.resolve( timer.available );

		const pending = this._gpuAttachments.get( renderer );
		if ( pending !== undefined ) return pending;

		if ( renderer.isWebGLRenderer === true ) {

			const legacyTimer = new WebGLTimer( this, renderer );
			this._gpuTimers.set( renderer, legacyTimer );
			return Promise.resolve( legacyTimer.available );

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
		const timer = new WebGPUTimer( this, renderer, available );
		this._gpuTimers.set( renderer, timer );

		if ( available === false ) {

			warnOnce( 'ProfilerService: Timestamp queries are unavailable; GPU profiling is disabled for this renderer.' );

		} else {

			this._warnIfPassTimestampsUnsupported( timer );

		}

		return available;

	}

	/**
	 * @param {string} label
	 * @param {Object} renderer
	 * @return {GpuSpanHandle}
	 */
	_beginGpuImpl( label, renderer ) {

		const timer = this._gpuTimers.get( renderer );
		if ( timer === undefined || timer.available === false ) return DUMMY_GPU_SPAN;
		return timer.begin( label );

	}

	/**
	 * @param {GpuSpanHandle} handle
	 */
	_endGpuImpl( handle ) {

		if ( handle._seq === 0 || handle._generation !== this._generation ) return;

		const timer = this._gpuTimers.get( handle.renderer );
		if ( timer !== undefined && timer.available ) timer.end( handle );

	}

	/**
	 * Resolves pending GPU timestamp queries for a renderer.
	 *
	 * @param {Object} renderer
	 * @return {Promise<void>}
	 */
	async flushGpu( renderer ) {

		const timer = this._gpuTimers.get( renderer );
		if ( timer !== undefined && timer.available ) await timer.flush();

	}

	/**
	 * @param {string} label
	 * @param {number} durationMs
	 * @param {number} ts Trace start (µs).
	 * @param {number} dur Trace duration (µs).
	 * @param {number} depth GPU span nesting depth.
	 * @param {string} [traceName=label] Trace slice name.
	 */
	_commitGpuSample( label, durationMs, ts, dur, depth, traceName = label ) {

		let record = this._gpuRecords.get( label );
		if ( record === undefined ) {

			record = createRecord( label, false );
			this._gpuRecords.set( label, record );

		}

		pushSample( record, durationMs, NaN );
		if ( this._traceCaptureEnabled || this._profile === 'full' ) {

			this._accumulateSession( this.sessionGpuTotals, label, durationMs );
			this._pushTraceSlice( traceName, ts, dur, TRACE_TID_GPU, depth );

		}

	}

	// Stats and export

	/**
	 * @param {string} label
	 * @return {ProfilerStats|null}
	 */
	getStats( label ) {

		const record = this._records.get( label );
		const stats = record === undefined ? null : summarize( record.inclusive, record.count );
		if ( stats === null ) return null;

		// Exclusive (self) time stats over the same window, skipping samples without self time.
		const self = summarize( record.self, record.count );

		return {
			label,
			samples: stats.samples,
			avg: stats.avg,
			min: stats.min,
			max: stats.max,
			p95: stats.p95,
			frameBudget: ( stats.avg / this.frameBudgetMs ) * 100,
			totalInvocations: record.invocations,
			selfAvg: self?.avg,
			selfMin: self?.min,
			selfMax: self?.max,
			selfP95: self?.p95,
			selfFrameBudget: self === null ? undefined : ( self.avg / this.frameBudgetMs ) * 100,
		};

	}

	/**
	 * @param {string} label
	 * @return {GpuProfilerStats|null}
	 */
	getGpuStats( label ) {

		const record = this._gpuRecords.get( label );
		const stats = record === undefined ? null : summarize( record.inclusive, record.count );
		if ( stats === null ) return null;

		return {
			label,
			samples: stats.samples,
			avg: stats.avg,
			min: stats.min,
			max: stats.max,
			p95: stats.p95,
			frameBudget: ( stats.avg / this.frameBudgetMs ) * 100,
			totalInvocations: record.invocations,
		};

	}

	/**
	 * @return {ProfilerStats[]}
	 */
	getAllStats() {

		return [ ...this._records.keys() ]
			.map( label => this.getStats( label ) )
			.filter( stats => stats !== null );

	}

	/**
	 * @return {GpuProfilerStats[]}
	 */
	getAllGpuStats() {

		return [ ...this._gpuRecords.keys() ]
			.map( label => this.getGpuStats( label ) )
			.filter( stats => stats !== null );

	}

	/**
	 * Uncapped totals for the current trace session. The stats ring does not affect these.
	 *
	 * @param {string} label
	 * @return {SessionStats|null}
	 */
	getSessionStats( label ) {

		const inclusive = this.sessionTotals.get( label );
		const self = this.sessionSelfTotals.get( label );
		if ( inclusive === undefined && self === undefined ) return null;

		/** @type {SessionStats} */
		const stats = {
			label,
			count: inclusive?.count ?? 0,
			totalMs: inclusive?.totalMs ?? 0,
			min: inclusive?.min ?? 0,
			max: inclusive?.max ?? 0,
		};

		if ( self !== undefined && self.count > 0 ) {

			stats.selfCount = self.count;
			stats.selfTotalMs = self.totalMs;
			stats.selfMin = self.min;
			stats.selfMax = self.max;

		}

		return stats;

	}

	/**
	 * @return {SessionStats[]}
	 */
	getAllSessionStats() {

		const labels = new Set( [ ...this.sessionTotals.keys(), ...this.sessionSelfTotals.keys() ] );
		return [ ...labels ]
			.map( label => this.getSessionStats( label ) )
			.filter( stats => stats !== null );

	}

	/**
	 * @param {string} label
	 * @return {GpuSessionStats|null}
	 */
	getGpuSessionStats( label ) {

		const stats = this.sessionGpuTotals.get( label );
		if ( stats === undefined ) return null;

		return { label, count: stats.count, totalMs: stats.totalMs, min: stats.min, max: stats.max };

	}

	/**
	 * @return {GpuSessionStats[]}
	 */
	getAllGpuSessionStats() {

		return [ ...this.sessionGpuTotals.keys() ]
			.map( label => this.getGpuSessionStats( label ) )
			.filter( stats => stats !== null );

	}

	/**
	 * @return {ProfilerStats[]}
	 */
	exportJSON() {

		return this.getAllStats();

	}

	/**
	 * @return {GpuProfilerStats[]}
	 */
	exportGpuJSON() {

		return this.getAllGpuStats();

	}

	report() {

		const stats = this.getAllStats();
		const gpuStats = this.getAllGpuStats();
		if ( stats.length === 0 && gpuStats.length === 0 ) {

			console.log( '[ProfilerService] No data. Enable profiling first and wait a few frames.' );
			return;

		}

		stats.sort( ( a, b ) => b.avg - a.avg );
		console.table( stats.map( s => ( {
			label: s.label,
			'avg ms': s.avg.toFixed( 3 ),
			'self avg ms': s.selfAvg === undefined ? '' : s.selfAvg.toFixed( 3 ),
			'min ms': s.min.toFixed( 3 ),
			'max ms': s.max.toFixed( 3 ),
			'p95 ms': s.p95.toFixed( 3 ),
			'budget %': s.frameBudget.toFixed( 1 ) + '%',
			samples: s.samples,
			calls: s.totalInvocations,
		} ) ) );

		if ( gpuStats.length > 0 ) {

			gpuStats.sort( ( a, b ) => b.avg - a.avg );
			console.log( '[ProfilerService] GPU timings' );
			console.table( gpuStats.map( s => ( {
				label: s.label,
				'avg ms': s.avg.toFixed( 3 ),
				'min ms': s.min.toFixed( 3 ),
				'max ms': s.max.toFixed( 3 ),
				'p95 ms': s.p95.toFixed( 3 ),
				'budget %': s.frameBudget.toFixed( 1 ) + '%',
				samples: s.samples,
				calls: s.totalInvocations,
			} ) ) );

		}

	}

	/**
	 * @param {number} [minDurationMs=0] Omit complete spans shorter than this duration (ms). Capture is unaffected.
	 * @return {ChromeTrace}
	 */
	exportChromeTrace( minDurationMs = 0 ) {

		return buildChromeTrace( this._trace, toThresholdMs( minDurationMs ) * 1000 );

	}

	/**
	 * @param {string} [filename='gnsx-trace.json']
	 * @param {number} [minDurationMs=0] Omit complete spans shorter than this duration (ms).
	 */
	downloadTrace( filename = 'gnsx-trace.json', minDurationMs = 0 ) {

		if ( this._traceSink !== null ) {

			console.log( '[ProfilerService] Trace is streaming to a sink. downloadTrace() does not read that file.' );
			return;

		}

		if ( typeof document === 'undefined' ) {

			console.log( '[ProfilerService] downloadTrace() only works in the browser. Use exportChromeTrace() in Node.js.' );
			return;

		}

		if ( this._profile !== 'full' ) {

			console.log( `[ProfilerService] No trace — current profile is '${this._profile}'. Use setProfile('full') before enabling.` );
			return;

		}

		if ( this._trace.length === 0 ) {

			console.log( '[ProfilerService] No trace events. Enable the profiler and play for a few seconds first.' );
			return;

		}

		const thresholdMs = toThresholdMs( minDurationMs );
		const trace = this.exportChromeTrace( thresholdMs );
		const eventCount = trace.traceEvents.filter( e => e.ph === 'X' ).length;
		// One string per event: a single JSON.stringify of a long session can exceed the
		// engine's maximum string length.
		const parts = [ `{"displayTimeUnit":${JSON.stringify( trace.displayTimeUnit )},"traceEvents":[` ];
		for ( let i = 0; i < trace.traceEvents.length; i ++ ) {

			parts.push( ( i === 0 ? '' : ',' ) + JSON.stringify( trace.traceEvents[ i ] ) );

		}

		parts.push( ']}' );
		const url = URL.createObjectURL( new Blob( parts, { type: 'application/json' } ) );
		const a = document.createElement( 'a' );
		a.href = url;
		a.download = filename;
		a.click();
		// Revoking synchronously can cancel the download in some browsers.
		setTimeout( () => URL.revokeObjectURL( url ), 1000 );
		const thresholdNote = thresholdMs > 0
			? ` (filtered ${this._trace.length - eventCount} spans < ${thresholdMs} ms)`
			: '';
		console.log( `[ProfilerService] Trace downloaded: ${filename} (${eventCount} events${thresholdNote})` );

	}

}

/**
 * Ring buffers of the most recent samples for one label. Inclusive and self samples share
 * one cursor so both stats cover the same calls; `NaN` marks a sample without that time.
 *
 * @typedef {Object} SampleRecord
 * @property {string} label
 * @property {Float64Array} inclusive
 * @property {?Float64Array} self `null` for GPU records.
 * @property {number} cursor
 * @property {number} count Valid samples in the ring buffers.
 * @property {number} invocations Total (uncapped) samples since last reset.
 * @property {number} open Frames on the call stack for this label.
 * @property {Array<{ t0: number, traceName: string }>} orphans Scopes dropped from the call stack while open.
 */

/**
 * @typedef {Object} Frame
 * @property {SampleRecord} record
 * @property {number} seq Span id, or `0` for a scope.
 * @property {number} t0
 * @property {number} childTime Time spent in closed child frames (ms).
 * @property {string} traceName
 */

/**
 * @param {string} label
 * @param {boolean} withSelf
 * @return {SampleRecord}
 */
function createRecord( label, withSelf ) {

	return {
		label,
		inclusive: new Float64Array( RING_SIZE ),
		self: withSelf ? new Float64Array( RING_SIZE ) : null,
		cursor: 0,
		count: 0,
		invocations: 0,
		open: 0,
		orphans: [],
	};

}

/**
 * @param {SampleRecord} record
 * @param {number} inclusive
 * @param {number} self
 */
function pushSample( record, inclusive, self ) {

	const cursor = record.cursor;
	record.inclusive[ cursor ] = inclusive;
	if ( record.self !== null ) record.self[ cursor ] = self;
	record.cursor = cursor + 1 === RING_SIZE ? 0 : cursor + 1;
	if ( record.count < RING_SIZE ) record.count ++;
	record.invocations ++;

}

/**
 * @param {Float64Array} values
 * @param {number} count
 * @return {?{ samples: number, avg: number, min: number, max: number, p95: number }} `null` without samples.
 */
function summarize( values, count ) {

	const sorted = [];
	for ( let i = 0; i < count; i ++ ) {

		if ( Number.isNaN( values[ i ] ) === false ) sorted.push( values[ i ] );

	}

	if ( sorted.length === 0 ) return null;

	sorted.sort( ( a, b ) => a - b );
	let sum = 0;
	for ( const value of sorted ) sum += value;

	return {
		samples: sorted.length,
		avg: sum / sorted.length,
		min: sorted[ 0 ],
		max: sorted[ sorted.length - 1 ],
		// Nearest rank.
		p95: sorted[ Math.max( 0, Math.ceil( sorted.length * 0.95 ) - 1 ) ],
	};

}

/**
 * @param {number} minDurationMs
 * @return {number} `minDurationMs`, or `0` when it is not a positive finite number.
 */
function toThresholdMs( minDurationMs ) {

	return Number.isFinite( minDurationMs ) && minDurationMs > 0 ? minDurationMs : 0;

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
 * @typedef {Object} SpanHandle
 * @property {string} label
 * @property {number} t0
 * @property {number} _seq `0` for a no-op handle and once the span has ended.
 * @property {number} _generation Session the span started in.
 */

/**
 * @typedef {Object} BeginSpanOptions
 * @property {boolean} [asyncTimeline] When true, the span is ended from an async continuation
 * and does not take part in self-time nesting.
 */

/**
 * @typedef {Object} EndSpanOptions
 * @property {boolean} [asyncTimeline] When true, trace slice uses `tid=2` (virtual async row).
 */

/**
 * @typedef {Object} GpuSpanHandle
 * @property {string} label
 * @property {?Object} renderer
 * @property {number} t0
 * @property {number} _seq
 * @property {number} _generation
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
 * @property {{ depth: number }} args `depth` is the nesting depth when the slice was recorded.
 * It breaks ties between slices with the same `ts` and `dur`, where overlap cannot say which
 * encloses which.
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

// Decorators

function isThenable( x ) {

	return ( typeof x === 'object' || typeof x === 'function' ) && x !== null && typeof x.then === 'function';

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

	if ( arguments.length === 0 ) return defaultProfileDecorator;

	if ( arguments.length === 1 && typeof targetOrTag === 'string' ) {

		return ( target, key, desc ) => applyProfileToMethod( targetOrTag, desc );

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
		Object.defineProperty( proto, key, applyProfileToMethod( `${constructor.name}.${key}`, { ...descriptor } ) );

	}

	return constructor;

}

export { ProfilerService, profile, profileClass };
// !WITH_GENESYS
