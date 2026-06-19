// WITH_GENESYS
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
/** Max events in the trace log (~50s at 60fps with 8 labels). */
const MAX_TRACE_EVENTS = 50_000;
const TRACE_TID_MAIN = 1;
const TRACE_TID_ASYNC = 2;
const NOOP = () => {};
const DUMMY_SPAN = Object.freeze( { label: '', t0: 0, _seq: 0 } );
const NOOP_BEGIN_SPAN = () => DUMMY_SPAN;
const NOOP_END_SPAN = () => {};

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

		if ( this._enabled ) {

			this.traceStartTime = performance.now();
			this.begin = this._beginImpl.bind( this );
			this.end = this._endImpl.bind( this );
			this.beginSpan = this._beginSpanImpl.bind( this );
			this.endSpan = this._endSpanImpl.bind( this );
			this._exposeGlobal();
			console.log( `[ProfilerService] auto-started from env (profile: ${this._profile})` );

		} else {

			this.begin = NOOP;
			this.end = NOOP;
			this.beginSpan = NOOP_BEGIN_SPAN;
			this.endSpan = NOOP_END_SPAN;

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
			const selfTime = Math.max( 0, duration - top.childTime );

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
			if ( parent !== undefined ) parent.childTime += duration;

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
	 * @return {import('./ProfilerService.js').ProfilerStats[]}
	 */
	getAllStats() {

		return [ ...this.buffers.keys() ]
			.map( label => this.getStats( label ) )
			.filter( s => s !== null );

	}

	report() {

		const stats = this.getAllStats();
		if ( stats.length === 0 ) {

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

	_clearState() {

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
 * @typedef {Object} SpanHandle
 * @property {string} label
 * @property {number} t0
 * @property {number} _seq
 * @property {string} _startMark
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
 * @property {'gnsx'} cat
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
