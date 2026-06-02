// WITH_GENESYS
/**
 * ProfilerService — per-label CPU timing with ring-buffer aggregation and DevTools integration.
 *
 * Activate via environment variable:
 *   PROFILING=1       stats + trace (full profile)
 *   PROFILING=stats   stats only, no trace accumulation (lower overhead)
 *
 * Quick start (browser console):
 *   __gnsx_profiler.enable()
 *   // play for a few seconds
 *   __gnsx_profiler.report()         // sorted console.table (aggregated stats)
 *   __gnsx_profiler.downloadTrace()  // download gnsx-trace.json for Speedscope / Perfetto
 *   __gnsx_profiler.reset()          // clear samples and trace
 *   __gnsx_profiler.disable()
 */

const RING_SIZE = 120;
const FRAME_BUDGET_MS = 1000 / 60;
/** Max events in the trace log (~50s at 60fps with 8 labels). */
const MAX_TRACE_EVENTS = 50_000;
const NOOP = () => {};

function _readProfilingEnv() {

	const raw =
		( typeof process !== 'undefined' ? process.env?.[ 'PROFILING' ] : undefined ) ??
		( typeof globalThis !== 'undefined' ? globalThis[ '__gnsx_env__' ]?.[ 'PROFILING' ] : undefined ) ??
		( typeof globalThis !== 'undefined' ? globalThis[ '__GNSX_PROFILING__' ] : undefined );

	if ( ! raw || raw === '0' || raw === 'false' ) return false;
	if ( raw === 'stats' ) return 'stats';
	return 'full';

}

class ProfilerServiceClass {

	constructor() {

		const envProfile = _readProfilingEnv();
		this._profile = envProfile !== false ? envProfile : 'full';
		this._enabled = envProfile !== false;

		/** @type {Map<string, Float64Array>} */
		this.buffers = new Map();
		/** @type {Map<string, number>} */
		this.cursors = new Map();
		/** @type {Map<string, number>} */
		this.counts = new Map();
		/** @type {Map<string, number>} */
		this.marks = new Map();
		/** @type {Array<{ name: string, ph: 'X', ts: number, dur: number, pid: 1, tid: 1, cat: 'gnsx' }>} */
		this.traceEvents = [];
		this.traceStartTime = 0;

		if ( this._enabled ) {

			this.traceStartTime = performance.now();
			this.begin = this._beginImpl.bind( this );
			this.end = this._endImpl.bind( this );
			this._exposeGlobal();
			console.log( `[ProfilerService] auto-started from env (profile: ${this._profile})` );

		} else {

			this.begin = NOOP;
			this.end = NOOP;

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
		this._exposeGlobal();
		console.log( `[ProfilerService] enabled (profile: ${this._profile}) — call __gnsx_profiler.report() or downloadTrace() from the console` );

	}

	disable() {

		this._clearState();
		this._enabled = false;
		this.begin = NOOP;
		this.end = NOOP;
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

		performance.mark( `gnsx:${label}:start` );
		this.marks.set( label, performance.now() );

	}

	/**
	 * @param {string} label
	 */
	_endImpl( label ) {

		const startTime = this.marks.get( label );
		if ( startTime === undefined ) return;
		this.marks.delete( label );

		const now = performance.now();
		const duration = now - startTime;

		performance.mark( `gnsx:${label}:end` );
		performance.measure( `gnsx:${label}`, `gnsx:${label}:start`, `gnsx:${label}:end` );

		let buffer = this.buffers.get( label );
		if ( ! buffer ) {

			buffer = new Float64Array( RING_SIZE );
			this.buffers.set( label, buffer );
			this.cursors.set( label, 0 );
			this.counts.set( label, 0 );

		}

		const cursor = this.cursors.get( label );
		buffer[ cursor ] = duration;
		this.cursors.set( label, ( cursor + 1 ) % RING_SIZE );
		this.counts.set( label, Math.min( ( this.counts.get( label ) + 1 ), RING_SIZE ) );

		if ( this._profile === 'full' && this.traceEvents.length < MAX_TRACE_EVENTS ) {

			this.traceEvents.push( {
				name: label,
				ph: 'X',
				ts: Math.round( ( startTime - this.traceStartTime ) * 1000 ),
				dur: Math.max( 1, Math.round( duration * 1000 ) ),
				pid: 1,
				tid: 1,
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

		return {
			label,
			samples: samples.length,
			avg,
			min: sorted[ 0 ],
			max: sorted[ sorted.length - 1 ],
			p95: sorted[ Math.floor( sorted.length * 0.95 ) ],
			frameBudget: ( avg / FRAME_BUDGET_MS ) * 100,
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

		return { traceEvents: [ ...this.traceEvents ] };

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
 */

/**
 * @typedef {Object} ChromeTrace
 * @property {Array<{ name: string, ph: 'X', ts: number, dur: number, pid: 1, tid: 1, cat: 'gnsx' }>} traceEvents
 * @property {{ 'clock-offset-since-epoch-ns'?: number }|undefined} [metadata]
 */

/**
 * @typedef {'full'|'stats'} ProfilingProfile
 */

const ProfilerService = new ProfilerServiceClass();

function applyProfileToMethod( label, descriptor ) {

	if ( _readProfilingEnv() === false ) return descriptor;

	const original = descriptor.value;

	function profiled( ...args ) {

		ProfilerService.begin( label );
		const result = original.apply( this, args );
		if ( result instanceof Promise ) {

			return result.finally( () => ProfilerService.end( label ) );

		}

		ProfilerService.end( label );
		return result;

	}

	descriptor.value = profiled;
	return descriptor;

}

/**
 * Method decorator that profiles the decorated method.
 * The label is automatically set to `ClassName.methodName`.
 *
 * @param {Object} target
 * @param {string|symbol} propertyKey
 * @param {PropertyDescriptor} descriptor
 * @return {PropertyDescriptor}
 */
function profile( target, propertyKey, descriptor ) {

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
